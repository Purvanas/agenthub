'use strict';

// Index dérivé des JSONL. Synchrone volontairement : cette classe ne tourne que dans le
// worker, jamais dans le thread HTTP.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { searchableText, snippet, MAX_MATCHES_PER_CONV, MAX_RESULTS } = require('./search');

const SCHEMA_VERSION = '1';
const HASH_WINDOW = 64 * 1024;
const RESULT_PREVIEW = 6000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function limitOf(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function projectItem(item) {
  if (!item || item.kind !== 'tool' || typeof item.result !== 'string' || item.result.length <= RESULT_PREVIEW) return item;
  return { ...item, result: item.result.slice(0, RESULT_PREVIEW), resultTruncated: true, resultLength: item.result.length };
}

function notableFiles(item) {
  const found = new Set();
  const visit = (value, key = '') => {
    if (typeof value === 'string' && /(file|path|filename|cwd)/i.test(key)) {
      if (value.length <= 2000) found.add(value);
    } else if (Array.isArray(value)) {
      // Le nom porteur de sens est souvent celui du tableau (`files`, `paths`). Les
      // indices `0`, `1`, ... ne doivent pas nous faire perdre cette information.
      for (const child of value) visit(child, key);
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) {
        visit(child, key ? `${key}.${childKey}` : childKey);
      }
    }
  };
  visit(item && item.input);
  return [...found].slice(0, 20);
}

function previewOf(item, max = 1500) {
  const text = typeof item.text === 'string' ? item.text : typeof item.result === 'string' ? item.result : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function literalFts(term) {
  return `"${String(term).replace(/"/g, '""')}"`;
}

class ConversationIndex {
  constructor({ databaseFile }) {
    if (!databaseFile) throw new TypeError('databaseFile requis');
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true });
    this.db = new DatabaseSync(databaseFile, { timeout: 5000 });
    try {
      try { fs.chmodSync(databaseFile, 0o600); } catch { /* ACL/Windows : conserver les droits du dossier data */ }
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
      this.db.function('contains_ci', { deterministic: true }, (text, needle) =>
        String(text || '').toLowerCase().includes(String(needle || '').toLowerCase()) ? 1 : 0
      );
      this.initializeSchema();
    } catch (err) {
      // Indispensable sous Windows : le worker doit pouvoir supprimer/recréer un index
      // dérivé corrompu, ce qui est impossible si son premier handle reste ouvert.
      try { this.db.close(); } catch { /* conserver l'erreur d'initialisation */ }
      throw err;
    }
  }

  initializeSchema() {
    this.db.exec('CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const version = this.db.prepare("SELECT value FROM index_meta WHERE key='schema_version'").get();
    if (version && version.value === SCHEMA_VERSION) {
      const mode = this.db.prepare("SELECT value FROM index_meta WHERE key='fts_mode'").get();
      this.ftsMode = mode ? mode.value : 'none';
      return;
    }
    this.db.exec(`
      DROP TRIGGER IF EXISTS items_ai; DROP TRIGGER IF EXISTS items_ad; DROP TRIGGER IF EXISTS items_au;
      DROP TABLE IF EXISTS item_fts; DROP TABLE IF EXISTS journal_state; DROP TABLE IF EXISTS items;
      DELETE FROM index_meta;
      CREATE TABLE journal_state (
        conv_id TEXT PRIMARY KEY, source_path TEXT NOT NULL, indexed_size INTEGER NOT NULL,
        observed_size INTEGER NOT NULL, mtime_ms REAL NOT NULL, source_identity TEXT NOT NULL,
        tail_hash TEXT NOT NULL
      );
      CREATE TABLE items (
        rowid INTEGER PRIMARY KEY, conv_id TEXT NOT NULL, item_key TEXT NOT NULL, item_id TEXT,
        position INTEGER NOT NULL, latest_offset INTEGER NOT NULL, latest_length INTEGER NOT NULL,
        kind TEXT, tool TEXT, ts TEXT, search_text TEXT NOT NULL, preview TEXT NOT NULL,
        files_json TEXT NOT NULL, UNIQUE(conv_id,item_key), UNIQUE(conv_id,position)
      );
      CREATE INDEX items_conv_position ON items(conv_id,position);
      CREATE INDEX items_conv_item_id ON items(conv_id,item_id);
      CREATE INDEX items_conv_kind_ts ON items(conv_id,kind,ts);
    `);
    this.ftsMode = 'none';
    try {
      this.db.exec("CREATE VIRTUAL TABLE item_fts USING fts5(search_text, content='items', content_rowid='rowid', tokenize='trigram')");
      this.ftsMode = 'trigram';
    } catch {
      try {
        this.db.exec("CREATE VIRTUAL TABLE item_fts USING fts5(search_text, content='items', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')");
        this.ftsMode = 'unicode61';
      } catch {
        this.ftsMode = 'none';
      }
    }
    if (this.ftsMode !== 'none') {
      this.db.exec(`
        CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
          INSERT INTO item_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
        CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
          INSERT INTO item_fts(item_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text); END;
        CREATE TRIGGER items_au AFTER UPDATE ON items BEGIN
          INSERT INTO item_fts(item_fts,rowid,search_text) VALUES('delete',old.rowid,old.search_text);
          INSERT INTO item_fts(rowid,search_text) VALUES(new.rowid,new.search_text); END;
      `);
    }
    const put = this.db.prepare('INSERT INTO index_meta(key,value) VALUES(?,?)');
    put.run('schema_version', SCHEMA_VERSION);
    put.run('fts_mode', this.ftsMode);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* garder l'erreur initiale */ }
      throw err;
    }
  }

  identity(stat) { return `${stat.dev || 0}:${stat.ino || 0}`; }

  readRange(file, start, end) {
    const length = Math.max(0, end - start);
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(file, 'r');
    try {
      let read = 0;
      while (read < length) {
        const count = fs.readSync(fd, buffer, read, length - read, start + read);
        if (!count) break;
        read += count;
      }
      return read === length ? buffer : buffer.subarray(0, read);
    } finally { fs.closeSync(fd); }
  }

  tailHash(file, end) {
    const start = Math.max(0, end - HASH_WINDOW);
    return crypto.createHash('sha256').update(this.readRange(file, start, end)).digest('hex');
  }

  upsertLine(convId, item, offset, length, nextPosition) {
    const key = item.id ? `id:${item.id}` : `anon:${offset}`;
    const old = this.db.prepare('SELECT rowid FROM items WHERE conv_id=? AND item_key=?').get(convId, key);
    const values = [offset, length, item.kind || null, item.tool || null, item.ts || null,
      searchableText(item), previewOf(item), JSON.stringify(notableFiles(item))];
    if (old) {
      this.db.prepare(`UPDATE items SET latest_offset=?,latest_length=?,kind=?,tool=?,ts=?,
        search_text=?,preview=?,files_json=? WHERE rowid=?`).run(...values, old.rowid);
      return nextPosition;
    }
    this.db.prepare(`INSERT INTO items(conv_id,item_key,item_id,position,latest_offset,latest_length,
      kind,tool,ts,search_text,preview,files_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(convId, key, item.id || null, nextPosition, ...values);
    return nextPosition + 1;
  }

  ingestBuffer(convId, buffer, baseOffset, reset) {
    const lastNewline = buffer.lastIndexOf(0x0a);
    const processed = lastNewline === -1 ? 0 : lastNewline + 1;
    let next = reset ? 1 : (this.db.prepare('SELECT MAX(position) AS n FROM items WHERE conv_id=?').get(convId).n || 0) + 1;
    for (let start = 0; start < processed;) {
      const end = buffer.indexOf(0x0a, start);
      const line = buffer.subarray(start, end);
      const offset = baseOffset + start;
      start = end + 1;
      if (!line.length) continue;
      let item;
      try { item = JSON.parse(line.toString('utf8')); }
      catch { continue; /* une ligne tronquée n'emporte pas le fil */ }
      next = this.upsertLine(convId, item, offset, line.length, next);
    }
    return processed;
  }

  writeState(convId, file, stat, indexedSize) {
    this.db.prepare(`INSERT INTO journal_state VALUES(?,?,?,?,?,?,?) ON CONFLICT(conv_id) DO UPDATE SET
      source_path=excluded.source_path,indexed_size=excluded.indexed_size,
      observed_size=excluded.observed_size,mtime_ms=excluded.mtime_ms,
      source_identity=excluded.source_identity,tail_hash=excluded.tail_hash`)
      .run(convId, file, indexedSize, stat.size, stat.mtimeMs, this.identity(stat), this.tailHash(file, indexedSize));
  }

  rebuild(convId, file, stat) {
    const buffer = this.readRange(file, 0, stat.size);
    this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE conv_id=?').run(convId);
      this.writeState(convId, file, stat, this.ingestBuffer(convId, buffer, 0, true));
    });
  }

  append(convId, file, stat, state) {
    const buffer = this.readRange(file, state.indexed_size, stat.size);
    this.transaction(() => {
      const count = this.ingestBuffer(convId, buffer, state.indexed_size, false);
      this.writeState(convId, file, stat, state.indexed_size + count);
    });
  }

  ensure(convId, file) {
    let stat;
    try { stat = fs.statSync(file); }
    catch (err) {
      if (err && err.code === 'ENOENT') { this.forget(convId); return false; }
      throw err;
    }
    const state = this.db.prepare('SELECT * FROM journal_state WHERE conv_id=?').get(convId);
    if (!state || state.source_path !== file || stat.size < state.observed_size ||
        this.identity(stat) !== state.source_identity) {
      this.rebuild(convId, file, stat); return true;
    }
    // Ne pas faire confiance au seul couple taille/mtime : une restauration peut préserver
    // ces deux valeurs. Le hash borné détecte également la réécriture courante d'un journal
    // avant de servir des offsets devenus faux, sans relire les dizaines de Mo du fichier.
    const sameIndexedTail = this.tailHash(file, state.indexed_size) === state.tail_hash;
    if (stat.size === state.observed_size && stat.mtimeMs === state.mtime_ms && sameIndexedTail) return true;
    if (stat.size === state.observed_size || !sameIndexedTail) {
      this.rebuild(convId, file, stat); return true;
    }
    this.append(convId, file, stat, state);
    return true;
  }

  readItem(file, row) {
    try { return JSON.parse(this.readRange(file, row.latest_offset, row.latest_offset + row.latest_length).toString('utf8')); }
    catch { return null; }
  }

  page(convId, file, spec = {}) {
    if (!this.ensure(convId, file)) return { items: [], page: { total: 0, hasMore: false, before: null, hasNewer: false, after: null } };
    const limit = limitOf(spec.limit);
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE conv_id=?').get(convId).n;
    const anchor = (id) => id ? this.db.prepare('SELECT position FROM items WHERE conv_id=? AND item_id=?').get(convId, String(id)) : null;
    const before = anchor(spec.before), after = anchor(spec.after), focus = anchor(spec.focus);
    let rows;
    const pageColumns = 'position,latest_offset,latest_length';
    if (before) rows = this.db.prepare(`SELECT ${pageColumns} FROM items WHERE conv_id=? AND position<? ORDER BY position DESC LIMIT ?`).all(convId, before.position, limit).reverse();
    else if (after) rows = this.db.prepare(`SELECT ${pageColumns} FROM items WHERE conv_id=? AND position>? ORDER BY position LIMIT ?`).all(convId, after.position, limit);
    else {
      const centered = focus ? focus.position - 1 - Math.floor(limit / 2) : total - limit;
      const offset = Math.max(0, Math.min(Math.max(0, total - limit), centered));
      rows = this.db.prepare(`SELECT ${pageColumns} FROM items WHERE conv_id=? ORDER BY position LIMIT ? OFFSET ?`).all(convId, limit, offset);
    }
    const items = rows.map((row) => projectItem(this.readItem(file, row))).filter(Boolean);
    const first = rows.length ? rows[0].position : 0, last = rows.length ? rows.at(-1).position : 0;
    return { items, page: { total, hasMore: first > 1,
      before: items.length ? items[0].id || null : null, hasNewer: last > 0 && last < total,
      after: items.length ? items.at(-1).id || null : null } };
  }

  result(convId, file, itemId) {
    if (!this.ensure(convId, file)) return { found: false, result: null };
    const row = this.db.prepare('SELECT latest_offset,latest_length FROM items WHERE conv_id=? AND item_id=?').get(convId, String(itemId));
    const item = row && this.readItem(file, row);
    return item ? { found: true, result: item.result == null ? null : item.result } : { found: false, result: null };
  }

  searchConversation(term, convId, filters = {}) {
    const rawKinds = filters.kinds == null ? filters.kind : filters.kinds;
    const kinds = (Array.isArray(rawKinds) ? rawKinds : rawKinds ? [rawKinds] : []).filter(Boolean).map(String);
    const baseConditions = ['i.conv_id=?', 'contains_ci(i.search_text,?)=1'];
    const baseParams = [convId, term];
    if (kinds.length) { baseConditions.push(`i.kind IN (${kinds.map(() => '?').join(',')})`); baseParams.push(...kinds); }
    if (filters.from) { baseConditions.push('i.ts>=?'); baseParams.push(String(filters.from)); }
    if (filters.to) {
      // Le client envoie une date issue d'un <input type=date>. Une comparaison brute à
      // `YYYY-MM-DD` exclurait tout le jour choisi puisque les timestamps ont une heure.
      const to = String(filters.to);
      baseConditions.push('i.ts<=?');
      baseParams.push(/^\d{4}-\d{2}-\d{2}$/.test(to) ? `${to}T23:59:59.999Z` : to);
    }
    // Seul le tokenizer trigram garantit la sémantique historique « sous-chaîne », y
    // compris au milieu d'un mot. unicode61 reste un bon format de secours pour la base,
    // mais l'utiliser comme filtre de candidats introduirait des faux négatifs. Compter les
    // points de code évite aussi de demander un trigramme pour deux emoji/caractères astrals.
    const useFts = this.ftsMode === 'trigram' && [...term].length >= 3;
    if (useFts) {
      try {
        return this.db.prepare(`SELECT i.item_id,i.kind,i.search_text,i.position FROM item_fts
          JOIN items i ON i.rowid=item_fts.rowid WHERE item_fts MATCH ? AND ${baseConditions.join(' AND ')}
          ORDER BY i.position LIMIT ?`).all(literalFts(term), ...baseParams, MAX_MATCHES_PER_CONV + 1);
      } catch { /* ponctuation FTS : scan exact ci-dessous */ }
    }
    return this.db.prepare(`SELECT i.item_id,i.kind,i.search_text,i.position FROM items i
      WHERE ${baseConditions.join(' AND ')} ORDER BY i.position LIMIT ?`)
      .all(...baseParams, MAX_MATCHES_PER_CONV + 1);
  }

  search(term, conversations, filters = {}) {
    const needle = String(term || '').trim().toLowerCase();
    if (needle.length < 2) return { term: needle, results: [], truncated: false };
    const results = [];
    let truncated = false;
    for (const conv of conversations) {
      if (!this.ensure(conv.id, conv.file)) continue;
      const rows = this.searchConversation(needle, conv.id, filters);
      const matches = rows.slice(0, MAX_MATCHES_PER_CONV).map((row) => {
        const at = row.search_text.toLowerCase().indexOf(needle);
        return { itemId: row.item_id, kind: row.kind, snippet: snippet(row.search_text, at, needle) };
      });
      if (!matches.length) continue;
      if (rows.length > MAX_MATCHES_PER_CONV) truncated = true;
      results.push({ convId: conv.id, title: conv.title, count: matches.length, matches });
      if (results.length >= MAX_RESULTS) { truncated = true; break; }
    }
    return { term: needle, results, truncated };
  }

  landmarks(convId, file) {
    if (!this.ensure(convId, file)) return { turns: [], files: [], latest: null, totalItems: 0, totalTurns: 0 };
    const totalItems = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE conv_id=?').get(convId).n;
    const totalTurns = this.db.prepare("SELECT COUNT(*) AS n FROM items WHERE conv_id=? AND kind='user'").get(convId).n;
    const userRows = this.db.prepare("SELECT latest_offset,latest_length FROM items WHERE conv_id=? AND kind='user' ORDER BY position DESC LIMIT 20").all(convId).reverse();
    const turns = userRows.map((row) => {
      const item = this.readItem(file, row);
      return item && { id: item.id || null, ts: item.ts || null, text: previewOf(item, 300), kind: item.kind || 'user' };
    }).filter(Boolean);
    const latestRow = this.db.prepare("SELECT item_id,preview,ts FROM items WHERE conv_id=? AND kind='text' AND preview<>'' ORDER BY position DESC LIMIT 1").get(convId);
    const fileRows = this.db.prepare("SELECT item_id,tool,files_json FROM items WHERE conv_id=? AND files_json<>'[]' ORDER BY position DESC").all(convId);
    const files = [], seen = new Set();
    const latest = latestRow
      ? { id: latestRow.item_id, text: latestRow.preview.slice(0, 1500), ts: latestRow.ts || null }
      : null;
    for (const row of fileRows) {
      for (const filePath of JSON.parse(row.files_json)) {
        if (!seen.has(filePath) && files.length < 20) { seen.add(filePath); files.push({ path: filePath, tool: row.tool || null, itemId: row.item_id }); }
      }
      if (files.length >= 20) break;
    }
    return { turns, files, latest, totalItems, totalTurns };
  }

  forget(convId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM items WHERE conv_id=?').run(convId);
      this.db.prepare('DELETE FROM journal_state WHERE conv_id=?').run(convId);
    });
  }

  close() { if (this.db && this.db.isOpen) this.db.close(); }
}

module.exports = { ConversationIndex, limitOf, projectItem, RESULT_PREVIEW };
