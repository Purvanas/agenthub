'use strict';

// Catalogue des modèles Grok, lu sur le CLI plutôt que figé dans models.json.
//
// `grok models` est la seule liste qui suit ce que le compte sert vraiment. Un relevé
// écrit à la main a déjà menti : l'interface annonçait grok-4.5 comme défaut alors que
// le CLI était passé à grok-4.7. On relit donc la commande, au plus une fois par jour,
// et on distingue deux choix qui ne sont pas le même modèle :
// - une entrée vide, qui ne passe aucun `--model` et suit donc le défaut du compte ;
// - chaque identifiant encore servi, qui fige la conversation sur cette version.

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

const EFFORT_LABELS = {
  low: 'Faible',
  medium: 'Moyen',
  high: 'Élevé',
  xhigh: 'Très élevé',
};

const EFFORT_RANK = { low: 1, medium: 2, high: 3, xhigh: 4, max: 5, ultra: 6 };

function binPath() {
  return process.env.AGENTHUB_GROK_BIN || 'grok';
}

function cacheFile(opts = {}) {
  return (
    opts.cacheFile ||
    process.env.AGENTHUB_GROK_MODELS_CACHE ||
    path.join(os.homedir(), '.grok', 'models_cache.json')
  );
}

/** `grok models` : le défaut, puis une ligne par modèle encore servi. */
function parseListing(text) {
  const source = String(text || '');
  const found = /^Default model:\s*(\S+)/m.exec(source);
  const ids = [];
  for (const line of source.split('\n')) {
    const match = /^\s*[*-]\s+(\S+)/.exec(line);
    if (match && !ids.includes(match[1])) ids.push(match[1]);
  }
  return {
    defaultModel: found ? found[1] : ids[0] || null,
    ids,
  };
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function cacheMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function infoOf(cache, id) {
  const entry = cache && cache.models && cache.models[id];
  return (entry && entry.info) || null;
}

function effortOptions(info) {
  const raw = ((info && info.reasoning_efforts) || []).filter((effort) => effort && effort.value);
  if (!raw.length) return null;
  const ordered = raw.slice().sort(
    (a, b) => (EFFORT_RANK[a.value] || 99) - (EFFORT_RANK[b.value] || 99)
  );
  return [
    { value: '', label: 'Défaut du modèle' },
    ...ordered.map((effort) => ({
      value: effort.value,
      label: EFFORT_LABELS[effort.value] || effort.label || effort.value,
      title: effort.description || '',
    })),
  ];
}

function fastVariant(id, info) {
  if (String(id).includes('-fast')) return true;
  const desc = (info && info.description) || '';
  return /fast/i.test(desc) && /2x|twice|deux fois/i.test(desc);
}

/**
 * Deux groupes. « Actuel » ne fige rien : le CLI choisit son défaut du moment.
 * « Encore desservis » sont les identifiants que `grok models` accepte encore.
 */
function buildCatalog(text, cache) {
  const { defaultModel, ids } = parseListing(text);
  if (!defaultModel || !ids.length) return null;

  const defInfo = infoOf(cache, defaultModel);
  const defName = (defInfo && defInfo.name) || defaultModel;
  const rollingEfforts = effortOptions(defInfo);

  const rolling = {
    value: '',
    label: `Dernier modèle — ${defName}`,
    group: 'Actuel',
    note: 'Suit le défaut du compte. La liste est relue chaque jour : quand le modèle du jour change, ce choix change avec lui.',
    efforts: rollingEfforts,
  };

  const served = ids.map((id) => {
    const info = infoOf(cache, id);
    const name = (info && info.name) || id;
    const fast = fastVariant(id, info);
    const current = id === defaultModel;
    let detail = null;
    let note = 'Ancienne version encore servie. Elle ne suit pas le modèle du jour.';
    if (fast) {
      detail = 'variante rapide, deux fois le prix';
      note = 'Variante plus rapide de la même génération. La fiche du CLI indique deux fois le prix.';
    } else if (current) {
      detail = 'figé sur cette version';
      note = `Reste sur ${name}, même quand le défaut du compte avancera, tant que cette version est encore servie.`;
    }
    return {
      value: id,
      label: detail ? `${name} — ${detail}` : name,
      group: 'Encore desservis',
      note,
      title: (info && info.description) || '',
      efforts: effortOptions(info),
    };
  });

  return {
    models: [rolling, ...served],
    efforts: rollingEfforts || [
      { value: '', label: 'Défaut du compte' },
      { value: 'low', label: 'Faible' },
      { value: 'medium', label: 'Moyen' },
      { value: 'high', label: 'Élevé' },
    ],
    defaultModel,
  };
}

function fetchCatalog(opts = {}) {
  const run =
    opts.run ||
    ((command, args) =>
      execFileSync(command, args, {
        encoding: 'utf8',
        timeout: opts.timeoutMs || 8000,
        env: process.env,
      }));
  let text;
  try {
    text = run(opts.bin || binPath(), ['models']);
  } catch {
    return null;
  }
  const cache = opts.cache === undefined ? readCache(cacheFile(opts)) : opts.cache;
  return buildCatalog(text, cache);
}

// Mémoire du processus. Un échec ne relance pas la commande à chaque ouverture de page.
let cached = { at: 0, attemptAt: 0, value: null };

function current(opts = {}) {
  const now = opts.now ? opts.now() : Date.now();
  const ttl = opts.ttlMs == null ? DAY_MS : opts.ttlMs;
  const retry = opts.retryMs == null ? RETRY_MS : opts.retryMs;
  const moved = cacheMtime(cacheFile(opts)) > cached.at;
  if (cached.value && now - cached.at < ttl && !moved) return cached.value;
  if (cached.attemptAt && now - cached.attemptAt < retry && !moved) return cached.value;
  cached.attemptAt = now;
  const fresh = fetchCatalog(opts);
  if (fresh) {
    cached.at = now;
    cached.value = fresh;
  }
  return cached.value;
}

function resetCache() {
  cached = { at: 0, attemptAt: 0, value: null };
}

module.exports = {
  parseListing,
  buildCatalog,
  fetchCatalog,
  current,
  resetCache,
  DAY_MS,
  RETRY_MS,
};
