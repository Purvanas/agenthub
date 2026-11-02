'use strict';

// Recherche plein texte dans les fils.
//
// La recherche de la sidebar ne portait que sur le titre et le dossier de travail. Or
// l'intérêt de garder tout l'historique est de pouvoir y retrouver quelque chose : « où
// est-ce que j'ai déjà vu cette erreur », « quelle conversation touchait ce fichier ».
//
// L'index est en mémoire, invalidé par la date de modification du journal : une
// conversation n'est relue que si elle a bougé depuis la dernière recherche. À l'échelle
// visée — un utilisateur, quelques centaines de conversations — c'est suffisant, et ça
// évite d'ajouter une base de données à une application qui n'en a pas.

const fs = require('fs');
const path = require('path');

/** Un extrait de contexte plus long ne tient pas dans la sidebar. */
const SNIPPET_RADIUS = 60;
const MAX_MATCHES_PER_CONV = 5;
const MAX_RESULTS = 40;

// convId -> { mtimeMs, size, entries: [{ itemId, kind, text }] }
const cache = new Map();

/** Ce qui est cherchable dans un item : son texte, et le résultat d'un outil. */
function searchableText(item) {
  const parts = [];
  if (typeof item.text === 'string') parts.push(item.text);
  if (typeof item.result === 'string') parts.push(item.result);
  if (item.tool) parts.push(item.tool);
  if (item.input) {
    // Les entrées d'outils portent souvent le chemin ou la commande qu'on recherche.
    for (const value of Object.values(item.input)) {
      if (typeof value === 'string') parts.push(value);
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
  for (const line of raw.split('\n')) {
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

/** Entrées cherchables d'une conversation, relues seulement si son journal a bougé. */
function entriesOf(convId, file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    cache.delete(convId);
    return [];
  }

  const hit = cache.get(convId);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.entries;

  const entries = readEntries(file);
  cache.set(convId, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries;
}

/** Extrait centré sur la occurrence, avec des ellipses là où on a coupé. */
function snippet(text, at, term) {
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(text.length, at + term.length + SNIPPET_RADIUS);
  const cut = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${cut}${end < text.length ? '…' : ''}`;
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
      matches.push({ itemId: entry.itemId, kind: entry.kind, snippet: snippet(entry.text, at, needle) });
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

/** Oublie une conversation supprimée : sans ça son texte resterait cherchable en mémoire. */
function forget(convId) {
  cache.delete(convId);
}

module.exports = { search, forget, searchableText, snippet, MAX_MATCHES_PER_CONV, MAX_RESULTS };
