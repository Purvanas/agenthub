'use strict';

// Vue réseau d'une conversation.
//
// Le journal reste complet sur disque et en mémoire : cette couche décide seulement ce qui
// traverse HTTP ou WebSocket. Une conversation de plusieurs milliers d'items, avec des sorties
// d'outils de plusieurs centaines de kilo-octets, ne doit pas être téléchargée en entier pour
// afficher ses derniers échanges sur un téléphone.

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const RESULT_PREVIEW = 6000;

function limitOf(value) {
  const parsed = Number.parseInt(String(value == null ? '' : value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/** Allège une sortie d'outil pour le transport, sans modifier l'item conservé par le store. */
function projectItem(item) {
  if (!item || item.kind !== 'tool' || typeof item.result !== 'string') return item;
  if (item.result.length <= RESULT_PREVIEW) return item;
  return {
    ...item,
    result: item.result.slice(0, RESULT_PREVIEW),
    resultTruncated: true,
    resultLength: item.result.length,
  };
}

/**
 * Fenêtre stable d'items, adressée par les identifiants qui ne changent pas quand de nouveaux
 * messages arrivent. `before` et `after` excluent leur ancre ; `focus` centre au mieux l'item
 * demandé pour qu'un résultat de recherche puisse s'afficher sans charger tout le fil.
 */
function pageItems(items, spec = {}) {
  const rows = Array.isArray(items) ? items : [];
  const total = rows.length;
  const limit = limitOf(spec.limit);
  let start;
  let end;

  const indexOf = (id) => (id ? rows.findIndex((item) => item && item.id === String(id)) : -1);
  const beforeAt = indexOf(spec.before);
  const afterAt = indexOf(spec.after);
  const focusAt = indexOf(spec.focus);

  if (beforeAt !== -1) {
    end = beforeAt;
    start = Math.max(0, end - limit);
  } else if (afterAt !== -1) {
    start = afterAt + 1;
    end = Math.min(total, start + limit);
  } else if (focusAt !== -1) {
    start = Math.max(0, focusAt - Math.floor(limit / 2));
    end = Math.min(total, start + limit);
    start = Math.max(0, end - limit);
  } else {
    end = total;
    start = Math.max(0, end - limit);
  }

  const page = rows.slice(start, end).map(projectItem);
  return {
    items: page,
    page: {
      total,
      hasMore: start > 0,
      before: page.length ? page[0].id : null,
      hasNewer: end < total,
      after: page.length ? page[page.length - 1].id : null,
    },
  };
}

function fullResult(items, itemId) {
  const item = (Array.isArray(items) ? items : []).find(
    (candidate) => candidate && candidate.id === String(itemId)
  );
  if (!item) return { found: false, result: null };
  return { found: true, result: item.result == null ? null : item.result };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  RESULT_PREVIEW,
  limitOf,
  projectItem,
  pageItems,
  fullResult,
};
