'use strict';

// Moteur synchrone de recherche plein texte. En production il tourne dans le worker de
// `search-service.js` : lire et parser un journal de plusieurs dizaines de Mo ne bloque donc
// plus les WebSockets ni les requêtes HTTP. L'API synchrone reste utile aux tests et aux
// scripts ponctuels.

const fs = require('fs');

/** Un extrait de contexte plus long ne tient pas dans la sidebar. */
const SNIPPET_RADIUS = 60;
const MAX_MATCHES_PER_CONV = 5;
const MAX_RESULTS = 40;
const DEFAULT_MAX_CACHE_BYTES = 128 * 1024 * 1024;

/** Ce qui est cherchable dans un item : son texte, et le résultat d'un outil. */
function searchableText(item) {
  const parts = [];
  if (typeof item.text === 'string') parts.push(item.text);
  if (typeof item.result === 'string') parts.push(item.result);
  if (item.tool) parts.push(item.tool);
  if (item.input != null) {
    // Les entrées d'outils portent souvent le chemin ou la commande qu'on recherche. Les
    // schémas MCP peuvent les imbriquer (params.path, files[]...) : ne pas perdre ces
    // chaînes, et éviter aussi `Object.values("...")` qui dupliquerait une entrée string
    // caractère par caractère.
    const pending = [item.input];
    while (pending.length) {
      const value = pending.pop();
      if (typeof value === 'string') parts.push(value);
      else if (value && typeof value === 'object') pending.push(...Object.values(value));
    }
  }
  return parts.join('\n');
}

function readEntries(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  // Dernière écriture gagnante, comme à la relecture d'un fil : un résultat d'outil
  // remplace l'appel qui ne l'avait pas encore.
  const byId = new Map();
  let anonymous = 0;
  // Une ligne à la fois : `split` dupliquait en pic la structure complète des très gros
  // journaux, précisément pendant l'opération déjà la plus gourmande.
  for (let start = 0; start < raw.length; ) {
    let end = raw.indexOf('\n', start);
    if (end === -1) end = raw.length;
    const line = raw.slice(start, end);
    start = end + 1;
    if (!line.trim()) continue;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }
    const text = searchableText(item);
    if (!text.trim()) continue;
    byId.set(item.id || `#${anonymous++}`, { itemId: item.id || null, kind: item.kind, text });
  }
  return [...byId.values()];
}

/**
 * Approximation conservatrice de la mémoire retenue par les chaînes et les objets. Elle ne
 * cherche pas à prédire exactement V8 : son rôle est d'empêcher un cache sans plafond.
 */
function entriesSize(entries) {
  return entries.reduce(
    (total, entry) => total + entry.text.length * 2 + String(entry.itemId || '').length * 2 + 192,
    0
  );
}

/** Extrait centré sur l'occurrence, avec des ellipses là où on a coupé. */
function snippet(text, at, term) {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
  const cut = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${end < text.length ? '…' : ''}`;
}

/**
 * Crée un moteur avec son propre cache LRU. Une conversation plus grosse que le plafond
 * reste intégralement cherchable : elle est simplement relue à la requête suivante.
 */
function createSearch({ maxCacheBytes = DEFAULT_MAX_CACHE_BYTES } = {}) {
  const limit = Math.max(0, Number(maxCacheBytes) || 0);
  // convId -> { mtimeMs, size, bytes, entries }
  const cache = new Map();
  let cacheBytes = 0;

  function drop(convId) {
    const previous = cache.get(convId);
    if (!previous) return;
    cacheBytes -= previous.bytes;
    cache.delete(convId);
  }

  /** Entrées cherchables d'une conversation, relues seulement si son journal a bougé. */
  function entriesOf(convId, file) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      drop(convId);
      return [];
    }

    const hit = cache.get(convId);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
      // Map garde l'ordre d'insertion : replacer l'entrée à la fin en fait la plus récente.
      cache.delete(convId);
      cache.set(convId, hit);
      return hit.entries;
    }
    if (hit) drop(convId);

    const entries = readEntries(file);
    const bytes = entriesSize(entries);
    // Ne pas remplir la Map d'une entrée par conversation vide : elle ne ferait gagner
    // aucune lecture utile et contournerait le plafond, puisque son poids estimé vaut zéro.
    if (bytes > 0 && bytes <= limit) {
      while (cache.size && cacheBytes + bytes > limit) drop(cache.keys().next().value);
      cache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, bytes, entries });
      cacheBytes += bytes;
    }
    return entries;
  }

  /**
   * Cherche `term` dans les fils.
   *
   * @param {string} term
   * @param {Array<{id: string, title: string}>} conversations index de la sidebar
   * @param {(id: string) => string} fileOf chemin du journal d'une conversation
   * @returns {{term: string, results: Array, truncated: boolean}}
   */
  function search(term, conversations, fileOf) {
    const needle = String(term || '').trim().toLowerCase();
    if (needle.length < 2) return { term: needle, results: [], truncated: false };

    const results = [];
    let truncated = false;

    for (const conv of conversations) {
      const matches = [];
      for (const entry of entriesOf(conv.id, fileOf(conv.id))) {
        const at = entry.text.toLowerCase().indexOf(needle);
        if (at === -1) continue;
        matches.push({
          itemId: entry.itemId,
          kind: entry.kind,
          snippet: snippet(entry.text, at, needle),
        });
        if (matches.length >= MAX_MATCHES_PER_CONV) {
          truncated = true;
          break;
        }
      }
      if (!matches.length) continue;
      results.push({ convId: conv.id, title: conv.title, count: matches.length, matches });
      if (results.length >= MAX_RESULTS) {
        truncated = true;
        break;
      }
    }

    return { term: needle, results, truncated };
  }

  function forget(convId) {
    drop(convId);
  }

  function clear() {
    cache.clear();
    cacheBytes = 0;
  }

  function cacheInfo() {
    return { conversations: cache.size, bytes: cacheBytes, maxBytes: limit };
  }

  return { search, forget, clear, cacheInfo };
}

const defaultSearch = createSearch();

module.exports = {
  search: defaultSearch.search,
  forget: defaultSearch.forget,
  clear: defaultSearch.clear,
  cacheInfo: defaultSearch.cacheInfo,
  createSearch,
  searchableText,
  snippet,
  MAX_MATCHES_PER_CONV,
  MAX_RESULTS,
  DEFAULT_MAX_CACHE_BYTES,
};
