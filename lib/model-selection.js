'use strict';

// Une sélection de modèle a trois temps distincts :
// - `next` est la préférence modifiable de la conversation ;
// - `active` est la photo immuable réellement passée au CLI pour le turn courant ;
// - `last` est ce que le provider a mesuré, ou à défaut ce qu'agentHub a demandé.
//
// Les confondre rendait un changement effectué pendant un turn rétroactif dans les métriques.
// Plus grave, le modèle par défaut de pricing.json était présenté comme s'il avait été observé
// dans le CLI. Ce module ne lit volontairement jamais les tarifs : un prix de repli n'est pas
// une preuve d'exécution.

const fs = require('fs');
const path = require('path');
const grokCatalog = require('./grok-catalog');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'models.json');
let configuredCache = { mtimeMs: -1, value: require('../config/models.json') };

const CLAUDE_ALIASES = {
  opus: 'Opus (alias)',
  fable: 'Fable (alias)',
  sonnet: 'Sonnet (alias)',
  haiku: 'Haiku (alias)',
};

const UNKNOWN_DEFAULT_LABEL = 'Défaut CLI — modèle non confirmé';

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function liveGrok(value) {
  return value === undefined ? grokCatalog.current() : value;
}

// models.json est modifiable sans redémarrage (l'endpoint le relit déjà à chaque appel).
// Le runtime suit la même source ; une écriture partielle garde simplement le dernier relevé
// valide jusqu'à l'appel suivant.
function configured() {
  try {
    const mtimeMs = fs.statSync(CONFIG_FILE).mtimeMs;
    if (mtimeMs !== configuredCache.mtimeMs) {
      configuredCache = {
        mtimeMs,
        value: JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')),
      };
    }
  } catch {
    // L'API signalera le fichier illisible ; un turn déjà demandé ne perd pas sa sélection.
  }
  return configuredCache.value;
}

function shortLabel(value) {
  return String(value || '').split(/\s+[—–]\s+/)[0].trim();
}

function modelsFor(provider, live) {
  if (provider === 'grok' && live && Array.isArray(live.models)) return live.models;
  const config = configured();
  return Array.isArray(config[provider]) ? config[provider] : [];
}

function effortsFor(provider, model, live) {
  const options = modelsFor(provider, live);
  const entry = options.find((option) => clean(option.value) === clean(model));
  if (entry && Array.isArray(entry.efforts)) return entry.efforts;
  const config = configured();
  return (config.efforts && config.efforts[provider]) || [];
}

function grokName(live) {
  if (!live || !live.defaultModel) return null;
  const rolling = modelsFor('grok', live).find((entry) => !clean(entry.value));
  return (rolling && (rolling.name || shortLabel(rolling.label).replace(/^Dernier modèle\s*/i, '')))
    || live.defaultModel;
}

function modelLabel(provider, model, live) {
  const wanted = clean(model);
  if (!wanted) {
    if (provider === 'grok' && live && live.defaultModel) {
      return `Défaut CLI · ${grokName(live)}`;
    }
    return UNKNOWN_DEFAULT_LABEL;
  }
  if (provider === 'claude' && CLAUDE_ALIASES[wanted]) return CLAUDE_ALIASES[wanted];
  const entry = modelsFor(provider, live).find((option) => clean(option.value) === wanted);
  if (provider === 'codex') return wanted;
  return (entry && (entry.name || shortLabel(entry.label))) || wanted;
}

function effortLabel(provider, model, effort, live) {
  const wanted = clean(effort);
  if (!wanted) return 'Réglage du CLI';
  const entry = effortsFor(provider, model, live).find(
    (option) => clean(option.value) === wanted
  );
  return (entry && entry.label) || wanted;
}

function knownModel(provider, model, live) {
  const wanted = clean(model);
  return modelsFor(provider, live).some((option) => clean(option.value) === wanted);
}

function effortAllowed(provider, model, effort, live) {
  const wanted = clean(effort);
  if (!wanted) return true;
  // Un modèle personnalisé n'est pas invalidé par un catalogue daté : le CLI est l'autorité.
  if (!knownModel(provider, model, live)) return true;
  return effortsFor(provider, model, live).some((option) => clean(option.value) === wanted);
}

function next(conv, opts = {}) {
  const live = conv && conv.provider === 'grok' ? liveGrok(opts.liveGrok) : null;
  const model = clean(conv && conv.model);
  let effort = clean(conv && conv.effort);
  if (!effortAllowed(conv.provider, model, effort, live)) effort = null;
  const resolvedModel = !model && conv.provider === 'grok' && live
    ? clean(live.defaultModel)
    : null;
  return {
    model,
    label: modelLabel(conv.provider, model, live),
    effort,
    effortLabel: effortLabel(conv.provider, model, effort, live),
    mode: model ? 'pinned' : 'provider-default',
    source: model ? 'user' : 'cli-default',
    ...(resolvedModel
      ? { resolvedModel, resolvedSource: 'cli-catalog', checkedAt: live.checkedAt || null }
      : {}),
  };
}

/** Photo exacte prise avant la construction des arguments du CLI. */
function snapshot(conv, opts = {}) {
  const selected = next(conv, opts);
  const startedAt = opts.startedAt || new Date().toISOString();
  return Object.freeze({
    ...selected,
    // Le défaut Grok vivant est volontairement passé comme `--model`. Sans cela une reprise
    // de session pourrait conserver l'ancien modèle et contredire le choix « dernier modèle ».
    launchedModel: selected.model || selected.resolvedModel || null,
    launchedEffort: selected.effort || null,
    startedAt,
  });
}

function restore(record, conv, opts = {}) {
  const raw = record && record.modelSelection;
  const live = conv && conv.provider === 'grok' ? liveGrok(opts.liveGrok) : null;
  if (raw && typeof raw === 'object' && raw.startedAt) {
    return Object.freeze({
      model: clean(raw.model),
      label: raw.label || modelLabel(conv.provider, raw.model, live),
      effort: clean(raw.effort),
      effortLabel:
        raw.effortLabel ||
        effortLabel(conv.provider, raw.model, raw.effort, live),
      mode: raw.mode || (clean(raw.model) ? 'pinned' : 'provider-default'),
      source: raw.source || 'unknown-after-restart',
      ...(clean(raw.resolvedModel) ? { resolvedModel: clean(raw.resolvedModel) } : {}),
      ...(raw.resolvedSource ? { resolvedSource: raw.resolvedSource } : {}),
      ...(raw.checkedAt ? { checkedAt: raw.checkedAt } : {}),
      launchedModel: clean(raw.launchedModel),
      launchedEffort: clean(raw.launchedEffort),
      startedAt: raw.startedAt,
    });
  }

  // Ancien enregistrement inflight : le modèle courant de la conversation a pu être changé
  // pendant le turn. On préfère « inconnu » à une attribution fausse.
  return Object.freeze({
    model: null,
    label: 'Sélection inconnue après redémarrage',
    effort: null,
    effortLabel: 'Inconnu',
    mode: 'unknown',
    source: 'unknown-after-restart',
    launchedModel: null,
    launchedEffort: null,
    startedAt: (record && record.startedAt) || opts.startedAt || new Date().toISOString(),
  });
}

function lastFromResult(item, active) {
  const measured = Object.keys((item && item.modelUsage) || {});
  if (measured.length) return { models: measured, source: 'measured' };
  if (active && active.launchedModel) {
    return {
      models: [active.launchedModel],
      source: active.mode === 'pinned' ? 'requested' : 'catalog-default',
    };
  }
  return { models: [], source: 'provider-default-unknown' };
}

function mergeLast(current, candidate) {
  if (!current) return candidate;
  if (!candidate) return current;
  const rank = (value) =>
    value === 'measured'
      ? 3
      : value === 'requested' || value === 'catalog-default'
        ? 2
        : 1;
  if (rank(candidate.source) < rank(current.source)) return current;
  if (rank(candidate.source) > rank(current.source)) return candidate;
  return {
    models: [...new Set([...(current.models || []), ...(candidate.models || [])])],
    source: current.source,
  };
}

function last(conv) {
  const saved = conv && conv.lastModelSelection;
  if (saved && Array.isArray(saved.models) && saved.source) {
    return { models: saved.models.filter(Boolean), source: saved.source };
  }
  if (conv && Array.isArray(conv.lastModels) && conv.lastModels.length) {
    return { models: conv.lastModels.filter(Boolean), source: 'legacy' };
  }
  return null;
}

function state(conv, active, opts = {}) {
  return {
    next: next(conv, opts),
    active: active || null,
    last: last(conv),
  };
}

/**
 * Normalise les champs d'un PATCH. Changer de modèle avec un ancien client remet à zéro un
 * effort devenu incompatible ; envoyer explicitement un effort impossible renvoie une erreur.
 */
function patch(conv, body, opts = {}) {
  const live = conv && conv.provider === 'grok' ? liveGrok(opts.liveGrok) : null;
  const modelTouched = typeof body.model === 'string';
  const effortTouched = typeof body.effort === 'string';
  const model = modelTouched ? clean(body.model) : clean(conv.model);
  let effort = effortTouched ? clean(body.effort) : clean(conv.effort);

  if (!effortAllowed(conv.provider, model, effort, live)) {
    if (effortTouched) {
      return { error: `L’effort « ${effort} » n’est pas disponible pour ce modèle.` };
    }
    effort = null;
  }

  const out = {};
  if (modelTouched) out.model = model;
  if (effortTouched || (modelTouched && effort !== clean(conv.effort))) out.effort = effort;
  return { patch: out };
}

function enrichModels(models, live) {
  const out = {};
  for (const [provider, entries] of Object.entries(models)) {
    if (provider.startsWith('_') || provider === 'efforts' || !Array.isArray(entries)) continue;
    out[provider] = entries.map((entry) => {
      const value = clean(entry.value);
      const name = value
        ? modelLabel(provider, value, provider === 'grok' ? live : null)
        : provider === 'grok' && live
          ? modelLabel(provider, null, live)
          : UNKNOWN_DEFAULT_LABEL;
      const resolvedModel = value && provider !== 'claude'
        ? value
        : !value && provider === 'grok' && live
          ? clean(live.defaultModel)
          : null;
      return {
        ...entry,
        ...(Array.isArray(entry.efforts)
          ? { efforts: entry.efforts.map(normalizeEffortOption) }
          : {}),
        name,
        ...(resolvedModel ? { resolvedModel } : {}),
      };
    });
  }
  return out;
}

function normalizeEffortOption(option) {
  return clean(option && option.value)
    ? { ...option }
    : { ...option, value: '', label: 'Réglage du CLI' };
}

function enrichEfforts(efforts) {
  return Object.fromEntries(
    Object.entries(efforts || {}).map(([provider, entries]) => [
      provider,
      Array.isArray(entries) ? entries.map(normalizeEffortOption) : entries,
    ])
  );
}

function defaults(live) {
  return {
    claude: { model: null, label: UNKNOWN_DEFAULT_LABEL, source: 'unknown' },
    codex: { model: null, label: UNKNOWN_DEFAULT_LABEL, source: 'unknown' },
    grok: live && live.defaultModel
      ? {
          model: live.defaultModel,
          label: grokName(live),
          source: 'cli-catalog',
          checkedAt: live.checkedAt || null,
        }
      : { model: null, label: UNKNOWN_DEFAULT_LABEL, source: 'unknown' },
  };
}

module.exports = {
  next,
  snapshot,
  restore,
  last,
  lastFromResult,
  mergeLast,
  state,
  patch,
  enrichModels,
  enrichEfforts,
  defaults,
  effortAllowed,
  UNKNOWN_DEFAULT_LABEL,
};
