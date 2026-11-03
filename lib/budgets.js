'use strict';

// Budgets d'attention, pas coupe-circuits.
//
// Une limite dépassée produit une alerte que l'utilisateur peut masquer ou repousser. Ce
// module ne connaît ni process ni conversation en cours et ne peut donc rien interrompre :
// cette séparation rend le défaut « prévenir seulement » structurel, pas conventionnel.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'workspace.json');
const SCOPES = ['conversation', 'project'];
const METRICS = ['timeMs', 'tokens', 'costUsd'];

function empty() {
  return { version: 1, budgets: { rules: [], decisions: {} } };
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('format racine invalide');
    }
    const budgets = parsed.budgets && typeof parsed.budgets === 'object' ? parsed.budgets : {};
    return {
      ...parsed,
      version: 1,
      budgets: {
        rules: Array.isArray(budgets.rules) ? budgets.rules : [],
        decisions:
          budgets.decisions && typeof budgets.decisions === 'object' && !Array.isArray(budgets.decisions)
            ? budgets.decisions
            : {},
      },
    };
  } catch (err) {
    if (err && err.code === 'ENOENT') return empty();
    throw new Error(`Configuration workspace illisible : ${err.message}`);
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function cleanTarget(value) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, 1000);
}

function normalizeLimits(input) {
  const source = input && typeof input === 'object' ? input : {};
  const limits = {};
  for (const metric of METRICS) {
    if (source[metric] === undefined || source[metric] === null || source[metric] === '') continue;
    const value = Number(source[metric]);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Seuil ${metric} invalide`);
    }
    limits[metric] = metric === 'tokens' || metric === 'timeMs' ? Math.round(value) : value;
  }
  if (!Object.keys(limits).length) throw new Error('Au moins un seuil est requis');
  return limits;
}

function listRules() {
  return readState().budgets.rules
    .map((rule) => ({ ...rule, limits: { ...(rule.limits || {}) } }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** Crée ou remplace la règle d'une cible. Une cible n'a qu'un budget lisible à la fois. */
function saveRule(spec) {
  const input = spec || {};
  if (!SCOPES.includes(input.scope)) throw new Error(`Portée inconnue : ${input.scope || ''}`);
  const target = cleanTarget(input.target);
  if (!target) throw new Error('Cible manquante');
  const limits = normalizeLimits(input.limits);
  const state = readState();
  const rules = state.budgets.rules;
  let rule = input.id ? rules.find((row) => row.id === String(input.id)) : null;
  if (input.id && !rule) throw new Error('Budget introuvable');
  if (!rule) rule = rules.find((row) => row.scope === input.scope && row.target === target) || null;
  const conflict = rules.find(
    (row) => row !== rule && row.scope === input.scope && row.target === target
  );
  if (conflict) throw new Error('Cette cible possède déjà un budget');

  const now = new Date().toISOString();
  if (rule) {
    const moved = rule.scope !== input.scope || rule.target !== target;
    for (const [metric, limit] of Object.entries(rule.limits || {})) {
      if (moved || limits[metric] !== limit) {
        delete state.budgets.decisions[alertId(rule, metric, limit)];
      }
    }
    rule.scope = input.scope;
    rule.target = target;
    rule.limits = limits;
    rule.updatedAt = now;
  } else {
    rule = {
      id: crypto.randomUUID(),
      scope: input.scope,
      target,
      limits,
      createdAt: now,
      updatedAt: now,
    };
    rules.push(rule);
  }
  writeState(state);
  return { ...rule, limits: { ...rule.limits } };
}

function removeRule(id) {
  const state = readState();
  const before = state.budgets.rules.length;
  const removedRules = state.budgets.rules.filter((rule) => rule.id === String(id));
  const removedIds = new Set(removedRules.map((rule) => rule.id));
  state.budgets.rules = state.budgets.rules.filter((rule) => !removedIds.has(rule.id));
  if (state.budgets.rules.length === before) return false;
  // Les décisions ne servent plus et pourraient masquer une future règle portant le même id
  // dans des données restaurées : elles partent avec elle.
  for (const rule of removedRules) {
    for (const [metric, limit] of Object.entries(rule.limits || {})) {
      delete state.budgets.decisions[alertId(rule, metric, limit)];
    }
  }
  writeState(state);
  return true;
}

function alertId(rule, metric, limit) {
  const digest = crypto
    .createHash('sha256')
    .update(`${rule.id}\0${rule.scope}\0${rule.target}\0${metric}\0${limit}`)
    .digest('hex')
    .slice(0, 24);
  return `budget-${digest}`;
}

function alerts(metrics, now = new Date()) {
  const state = readState();
  const at = now instanceof Date ? now : new Date(now);
  const atMs = at.getTime();
  const source = metrics || {};
  const out = [];

  for (const rule of state.budgets.rules) {
    const bucket = rule.scope === 'conversation' ? source.conversations : source.projects;
    const measured = (bucket && bucket[rule.target]) || {};
    for (const metric of METRICS) {
      const limit = Number(rule.limits && rule.limits[metric]);
      const value = Number(measured[metric]) || 0;
      if (!Number.isFinite(limit) || limit <= 0 || value < limit) continue;
      const id = alertId(rule, metric, limit);
      const decision = state.budgets.decisions[id] || null;
      const snoozedUntil = decision && decision.snoozedUntil ? decision.snoozedUntil : null;
      let status = 'active';
      if (decision && decision.dismissedAt) status = 'dismissed';
      else if (snoozedUntil && Date.parse(snoozedUntil) > atMs) status = 'snoozed';
      out.push({
        id,
        ruleId: rule.id,
        scope: rule.scope,
        target: rule.target,
        metric,
        value,
        limit,
        ratio: value / limit,
        state: status,
        snoozedUntil,
        costEstimated: metric === 'costUsd',
        unknownCost: metric === 'costUsd' && Boolean(measured.unknownCost),
      });
    }
  }

  const rank = { active: 0, snoozed: 1, dismissed: 2 };
  return out.sort((a, b) => rank[a.state] - rank[b.state] || b.ratio - a.ratio);
}

function decide(id, patch) {
  const key = cleanTarget(id);
  if (!/^budget-[0-9a-f]{24}$/.test(key)) throw new Error('Alerte invalide');
  const state = readState();
  const known = state.budgets.rules.some((rule) =>
    Object.entries(rule.limits || {}).some(
      ([metric, limit]) => alertId(rule, metric, limit) === key
    )
  );
  if (!known) throw new Error('Alerte inconnue');
  state.budgets.decisions[key] = { ...(state.budgets.decisions[key] || {}), ...patch };
  writeState(state);
  return { id: key, ...state.budgets.decisions[key] };
}

function dismiss(id) {
  return decide(id, { dismissedAt: new Date().toISOString(), snoozedUntil: null });
}

function snooze(id, until) {
  const date = new Date(until);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) {
    throw new Error('Échéance de rappel invalide');
  }
  return decide(id, { dismissedAt: null, snoozedUntil: date.toISOString() });
}

module.exports = {
  FILE,
  SCOPES,
  METRICS,
  listRules,
  saveRule,
  removeRule,
  alerts,
  dismiss,
  snooze,
};
