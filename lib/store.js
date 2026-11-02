'use strict';

// Persistance simple : un index.json pour la sidebar, et par conversation deux
// fichiers — ses métadonnées et le journal de ses items.
// Volume attendu : quelques centaines de conversations, un seul utilisateur.
//
// Pourquoi deux fichiers. Les items étaient dans le même JSON que les métadonnées,
// donc chaque item ajouté réécrivait tout le fil. Mesuré sur un fil de 268 items
// (9,2 Mo) : 44 ms de `JSON.stringify` et 21 ms d'écriture, en synchrone, toutes les
// 400 ms pendant qu'un agent produit — et ça grandit avec la conversation. Le journal
// est donc append-only : ajouter un item coûte la taille de l'item, pas celle du fil.
//
// Un item déjà écrit peut changer : le résultat d'un outil arrive après son appel, et
// un avis se repeint en erreur quand le turn échoue. Plutôt que de réécrire le journal,
// on réécrit la ligne à la fin : à la lecture, la dernière version d'un identifiant
// gagne. C'est ce que fait `touchItem`.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const CONV_DIR = path.join(DATA_DIR, 'conv');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

fs.mkdirSync(CONV_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Écriture atomique : on passe par un .tmp puis rename, pour ne jamais laisser
// un JSON tronqué si le process meurt en pleine sauvegarde.
function writeJSON(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

let index = readJSON(INDEX_FILE, { conversations: [], folders: [], triggers: [] });
if (!Array.isArray(index.folders)) index.folders = [];
if (!Array.isArray(index.triggers)) index.triggers = [];

// Les métadonnées en cours d'écriture sont gardées en mémoire et flushées avec un
// debounce. Les items, eux, partent au fil de l'eau dans le journal : ils sont la
// seule chose qu'un crash en pleine génération ferait vraiment perdre.
const cache = new Map();
const dirty = new Set();
let flushTimer = null;

function convFile(id) {
  return path.join(CONV_DIR, `${id}.json`);
}

function itemsFile(id) {
  return path.join(CONV_DIR, `${id}.jsonl`);
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 400);
}

/** Métadonnées seules : les items vivent dans le journal, jamais dans le .json. */
function metaOf(conv) {
  const { items, ...meta } = conv;
  return meta;
}

function flush() {
  // Un flush explicite doit désarmer le flush programmé, sinon celui-ci refire ensuite et
  // réécrit l'index pour rien.
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  // Le flush est appelé depuis un minuteur : une exception ici ne serait rattrapée par
  // personne et emporterait le processus — donc toutes les conversations en cours, pour
  // un fichier qu'on n'a pas su écrire. On le signale et on continue.
  try {
    for (const id of dirty) {
      const conv = cache.get(id);
      if (conv) writeJSON(convFile(id), metaOf(conv));
    }
    dirty.clear();
    writeJSON(INDEX_FILE, index);
  } catch (err) {
    console.error(`sauvegarde impossible : ${err.message}`);
  }
}

// --- Journal des items ----------------------------------------------------

/** Écrit un journal complet, en atomique. Sert à la migration et à la compaction. */
function writeItems(id, items) {
  const file = itemsFile(id);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, items.map((it) => JSON.stringify(it)).join('\n') + (items.length ? '\n' : ''));
  fs.renameSync(tmp, file);
}

/**
 * Relit le journal d'une conversation. Dernière écriture gagnante : une ligne dont
 * l'identifiant a déjà été vu remplace la précédente **à sa place d'origine**, pour que
 * l'ordre du fil reste celui de la première apparition (c'est ce que garantit `Map`).
 */
function readItems(id) {
  let raw;
  try {
    raw = fs.readFileSync(itemsFile(id), 'utf8');
  } catch {
    return [];
  }

  const byId = new Map();
  let lines = 0;
  let anonymous = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    lines += 1;
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      // Ligne tronquée par un crash en pleine écriture : on perd cet item, pas le fil.
      continue;
    }
    // Un item sans identifiant ne peut pas être remplacé : on lui en donne un de
    // position, ce qui le garde dans l'ordre sans jamais l'écraser.
    byId.set(item.id || `#${anonymous++}`, item);
  }

  const items = [...byId.values()];
  // Compaction. En régime normal un item d'outil est écrit deux fois (l'appel, puis son
  // résultat) : le seuil laisse cette marge et ne se déclenche que sur un journal
  // réellement gonflé par des réécritures.
  if (lines > items.length * 3 + 50) writeItems(id, items);
  return items;
}

/**
 * Fait passer une conversation de l'ancien format (items dans le .json) au journal.
 * Le journal est écrit avant que les métadonnées soient allégées : une coupure entre
 * les deux laisse simplement la migration à rejouer, à l'identique.
 */
function migrate(id, meta) {
  const items = Array.isArray(meta.items) ? meta.items : [];
  if (!fs.existsSync(itemsFile(id)) || items.length) writeItems(id, items);
  const { items: _dropped, ...rest } = meta;
  writeJSON(convFile(id), rest);
  return { ...rest, items };
}

function indexEntry(conv) {
  return {
    id: conv.id,
    title: conv.title,
    provider: conv.provider,
    model: conv.model || null,
    cwd: conv.cwd,
    status: conv.status,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    lastCostUsd: conv.lastCostUsd || null,
    totalCostUsd: conv.totalCostUsd || 0,
    pinned: Boolean(conv.pinned),
    folder: conv.folder || null,
    parentId: conv.parentId || null,
    triggerId: conv.triggerId || null,
    // Seulement le nom de branche : la sidebar veut savoir qu'une conversation est isolée,
    // pas où son worktree est rangé sur le disque.
    branch: (conv.worktree && conv.worktree.branch) || null,
  };
}

function touchIndex(conv) {
  const entry = indexEntry(conv);
  const i = index.conversations.findIndex((c) => c.id === conv.id);
  if (i === -1) index.conversations.unshift(entry);
  else index.conversations[i] = entry;
  scheduleFlush();
  return entry;
}

exports.list = function list() {
  // Normalisation à la lecture : les entrées écrites avant l'ajout des favoris, des
  // dossiers et de la filiation n'ont pas ces champs, et migrer le fichier serait
  // plus fragile. Le front veut null et non undefined.
  return [...index.conversations]
    .map((c) => ({ pinned: false, folder: null, parentId: null, triggerId: null, ...c }))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
};

exports.get = function get(id) {
  if (cache.has(id)) return cache.get(id);
  const meta = readJSON(convFile(id), null);
  if (!meta) return null;
  // `items` dans le .json : conversation écrite avant le passage au journal.
  const conv = Array.isArray(meta.items) ? migrate(id, meta) : { ...meta, items: readItems(id) };
  cache.set(id, conv);
  return conv;
};

exports.create = function create({
  provider,
  cwd,
  model,
  effort,
  title,
  titleAuto,
  parentId,
  forkFrom,
  folder,
  triggerId,
  browser,
}) {
  const now = new Date().toISOString();
  const conv = {
    id: require('crypto').randomUUID(),
    provider,
    cwd,
    model: model || null,
    effort: effort || null,
    // Navigateur MCP branché sur cette conversation, pour du QA visuel. Par conversation
    // et non global : les outils d'un navigateur n'ont rien à faire dans une session qui
    // n'en a pas besoin.
    browser: Boolean(browser),
    title: title || 'Nouvelle conversation',
    // Le titre est-il encore celui que l'application a posé faute de mieux ? Tant qu'il l'est,
    // le modèle a le droit de le remplacer au premier message. Un titre écrit à la main, ou
    // celui d'une exécution de déclencheur, ne se fait jamais reprendre.
    titleAuto: titleAuto === undefined ? !title : Boolean(titleAuto),
    status: 'idle',
    // Renseignés à la fin de chaque turn, pour la jauge de contexte.
    contextTokens: 0,
    contextWindow: 0,
    // Modèle(s) réellement comptabilisé(s) au dernier turn. Peut différer de `model`,
    // qui n'est que la préférence passée au CLI et reste null quand il choisit son défaut.
    lastModels: [],
    // Messages en attente : ils ne rejoignent le fil qu'au moment où ils partent.
    queue: [],
    // Objectif en cours, quand la conversation tourne en mode objectif. Porté par la
    // conversation et non par le turn : la boucle doit survivre à un redémarrage, et se voir
    // depuis n'importe quel appareil.
    goal: null,
    // Worktree git propre à la conversation, quand elle en a un : `{repo, path, branch,
    // base, baseSha}`. Renseigné après la création, le chemin dépendant de l'identifiant.
    // Sa présence est ce qui distingue une conversation isolée d'une conversation qui écrit
    // directement dans le dossier du projet.
    worktree: null,
    pinned: false,
    folder: folder || null, // identifiant de dossier, ou null pour « sans dossier »
    // Déclencheur dont cette conversation est une exécution. Porté par la conversation
    // et non déduit du dossier : une conversation déplacée à la main dans le dossier d'un
    // déclencheur n'est pas une de ses exécutions, et ne doit ni être purgée ni comptée.
    triggerId: triggerId || null,
    // Conversation d'où celle-ci est dérivée. Aucun comportement serveur n'en dépend :
    // une conversation enfant se pilote exactement comme une autre.
    parentId: parentId || null,
    // Identifiant de session côté agent. Pour Claude on l'impose (--session-id),
    // pour Codex on le récupère dans le flux JSON.
    providerSessionId: null,
    sessionStarted: false,
    // Session à forker au premier turn, quand la conversation démarre sur le contexte
    // d'une autre. Consommée par `onSession` dès que le CLI a ouvert la session forkée.
    forkFrom: forkFrom || null,
    createdAt: now,
    updatedAt: now,
    totalCostUsd: 0,
    lastCostUsd: null,
    items: [],
  };
  // Claude et Grok acceptent qu'on impose l'identifiant de session (`--session-id`),
  // donc on réutilise celui de la conversation. Codex ne le permet pas : le sien est
  // récupéré dans son flux d'événements. Un démarrage par fork non plus : c'est le CLI
  // qui nomme la session forkée, et le champ doit rester vide pour que l'événement
  // `init` puisse y écrire l'identifiant qu'il a choisi.
  if (!conv.forkFrom && (provider === 'claude' || provider === 'grok')) {
    conv.providerSessionId = conv.id;
  }
  cache.set(conv.id, conv);
  dirty.add(conv.id);
  touchIndex(conv);
  return conv;
};

exports.update = function update(id, patch) {
  const conv = exports.get(id);
  if (!conv) return null;
  Object.assign(conv, patch);
  conv.updatedAt = new Date().toISOString();
  dirty.add(id);
  touchIndex(conv);
  return conv;
};

exports.addItem = function addItem(id, item) {
  const conv = exports.get(id);
  if (!conv) return null;
  const full = {
    id: require('crypto').randomUUID(),
    ts: new Date().toISOString(),
    ...item,
  };
  conv.items.push(full);
  conv.updatedAt = full.ts;
  // Le journal part tout de suite : c'est un ajout de la taille de l'item, et un item
  // perdu ne se retrouve nulle part ailleurs. Les métadonnées, elles, attendent le flush.
  fs.appendFileSync(itemsFile(id), `${JSON.stringify(full)}\n`);
  dirty.add(id);
  touchIndex(conv);
  return full;
};

/**
 * Persiste un item déjà dans le fil et modifié depuis : le résultat d'un outil qui
 * arrive, un avis repeint en erreur, une note de passation qu'on badge. La nouvelle
 * version est ajoutée en fin de journal et prime à la relecture.
 */
exports.touchItem = function touchItem(id, item) {
  const conv = exports.get(id);
  if (!conv || !item || !item.id) return null;
  fs.appendFileSync(itemsFile(id), `${JSON.stringify(item)}\n`);
  conv.updatedAt = new Date().toISOString();
  dirty.add(id);
  touchIndex(conv);
  return item;
};

// --- Filiation ------------------------------------------------------------

/** Identifiants des conversations dérivées de celle-ci, dans l'ordre de l'index. */
exports.children = function children(id) {
  return index.conversations.filter((c) => c.parentId === id).map((c) => c.id);
};

exports.hasChildren = function hasChildren(id) {
  return index.conversations.some((c) => c.parentId === id);
};

/**
 * Coupe le lien de filiation des enfants d'une conversation. Ils survivent au parent :
 * supprimer une conversation ne doit jamais emporter le travail dérivé d'elle.
 * Renvoie les identifiants détachés.
 */
function detachChildren(id) {
  const detached = [];
  for (const entry of index.conversations) {
    if (entry.parentId !== id) continue;
    entry.parentId = null;
    const conv = exports.get(entry.id);
    if (conv) {
      conv.parentId = null;
      dirty.add(conv.id);
    }
    detached.push(entry.id);
  }
  return detached;
}

exports.remove = function remove(id) {
  const detached = detachChildren(id);
  index.conversations = index.conversations.filter((c) => c.id !== id);
  cache.delete(id);
  dirty.delete(id);
  for (const file of [convFile(id), itemsFile(id)]) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* déjà absent */
    }
  }
  scheduleFlush();
  return detached;
};

/**
 * Suppression automatique, par opposition à `remove` qui répond à une action humaine :
 * elle épargne toute conversation ayant des enfants, pour ne pas faire disparaître le
 * contexte dont un relais est issu. Renvoie true si la suppression a eu lieu.
 */
exports.purge = function purge(id) {
  if (exports.hasChildren(id)) return false;
  exports.remove(id);
  return true;
};

// --- Dossiers -------------------------------------------------------------
// Ils vivent dans l'index et non sur les conversations, pour qu'un dossier vide
// existe quand même dans la sidebar.

exports.folders = function folders() {
  return [...index.folders];
};

exports.createFolder = function createFolder(name, cwd) {
  const folder = { id: require('crypto').randomUUID(), name: name.trim().slice(0, 60) };
  // Dossier de projet : on retient le chemin qui l'a fait naître, pour y ranger les
  // conversations suivantes du même projet.
  if (cwd) folder.cwd = cwd;
  index.folders.push(folder);
  scheduleFlush();
  return folder;
};

/**
 * Dossier du projet d'un chemin de travail, créé au besoin.
 *
 * Rapproché sur le **chemin** et non sur le nom : deux projets peuvent finir par le même
 * nom de dossier (`.../client-a/site` et `.../client-b/site`), et les confondre mélangerait
 * deux historiques sans moyen de les redémêler.
 *
 * Un dossier créé à la main, sans chemin, n'est jamais réquisitionné : c'est un rangement
 * choisi par l'utilisateur, pas un rangement automatique.
 */
exports.folderForCwd = function folderForCwd(cwd) {
  const dir = String(cwd || '').replace(/[/\\]+$/, '');
  if (!dir) return null;

  const existing = index.folders.find((f) => f.cwd === dir);
  if (existing) return existing;

  const name = dir.split(/[/\\]/).filter(Boolean).pop() || dir;
  return exports.createFolder(name, dir);
};

/**
 * Réordonne les dossiers, pour qu'un projet puisse être mis tout en haut ou tout en bas.
 *
 * L'ordre d'affichage **est** l'ordre du tableau : pas de champ `order` à côté. Rien à migrer
 * pour les dossiers déjà créés, et surtout aucun moyen que deux dossiers finissent au même
 * rang — ce qui donnerait un ordre dépendant du tri, donc instable d'un rendu à l'autre.
 *
 * Les identifiants inconnus sont ignorés, et les dossiers qu'on oublie de citer restent à la
 * fin dans leur ordre actuel. C'est ce qui rend l'opération sûre quand le client n'a qu'une
 * vue partielle de la liste : un dossier créé entre son affichage et son glisser-déposer ne
 * doit pas disparaître de l'ordre.
 *
 * @param {string[]} ids identifiants dans l'ordre voulu
 * @returns {object[]} la liste réordonnée
 */
exports.reorderFolders = function reorderFolders(ids) {
  const byId = new Map(index.folders.map((f) => [f.id, f]));
  const ordered = [];
  const seen = new Set();

  for (const id of Array.isArray(ids) ? ids : []) {
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    ordered.push(byId.get(id));
  }
  for (const folder of index.folders) if (!seen.has(folder.id)) ordered.push(folder);

  index.folders = ordered;
  scheduleFlush();
  return [...index.folders];
};

exports.renameFolder = function renameFolder(id, name) {
  const folder = index.folders.find((f) => f.id === id);
  if (!folder) return null;
  folder.name = name.trim().slice(0, 60);
  scheduleFlush();
  return folder;
};

/** Supprime le dossier ; les conversations qu'il contenait redeviennent sans dossier. */
exports.removeFolder = function removeFolder(id) {
  index.folders = index.folders.filter((f) => f.id !== id);
  for (const entry of index.conversations) {
    if (entry.folder === id) {
      entry.folder = null;
      const conv = exports.get(entry.id);
      if (conv) {
        conv.folder = null;
        dirty.add(conv.id);
      }
    }
  }
  scheduleFlush();
};

// --- Déclencheurs ---------------------------------------------------------
// Comme les dossiers, ils vivent dans l'index et non sur les conversations : un
// déclencheur doit exister avant sa première exécution, et lui survivre.

exports.triggers = function triggers() {
  return [...index.triggers];
};

exports.getTrigger = function getTrigger(id) {
  return index.triggers.find((t) => t.id === id) || null;
};

exports.createTrigger = function createTrigger(data) {
  // Chaque déclencheur a son dossier de sidebar : ses exécutions s'y rangent au lieu de
  // noyer les conversations ouvertes à la main.
  const folder = exports.createFolder(data.name);
  const trigger = {
    id: require('crypto').randomUUID(),
    ...data,
    folder: folder.id,
    createdAt: new Date().toISOString(),
    nextRunAt: data.nextRunAt || null,
    lastRunAt: null,
    lastStatus: null,
    lastConvId: null,
  };
  index.triggers.push(trigger);
  scheduleFlush();
  return trigger;
};

exports.updateTrigger = function updateTrigger(id, patch) {
  const trigger = exports.getTrigger(id);
  if (!trigger) return null;
  Object.assign(trigger, patch);
  // Le dossier porte le nom du déclencheur : le renommer sans lui laisserait la
  // sidebar mentir sur l'origine de ses exécutions.
  if (patch.name && trigger.folder) exports.renameFolder(trigger.folder, patch.name);
  scheduleFlush();
  return trigger;
};

/**
 * Supprime le déclencheur sans toucher à ses exécutions passées : elles sont des
 * conversations ordinaires, et son dossier reste pour qu'elles restent groupées.
 */
exports.removeTrigger = function removeTrigger(id) {
  const before = index.triggers.length;
  index.triggers = index.triggers.filter((t) => t.id !== id);
  scheduleFlush();
  return index.triggers.length !== before;
};

exports.flush = flush;
exports.DATA_DIR = DATA_DIR;
exports.CONV_DIR = CONV_DIR;
exports.itemsFile = itemsFile;
