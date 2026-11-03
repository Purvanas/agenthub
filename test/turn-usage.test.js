'use strict';

// Ces régressions chargent les vraies fonctions de server.js dans un contexte sans ouvrir
// de port ni démarrer les minuteurs du serveur. Les dépendances d'orchestration sont simulées,
// mais le calcul de durée et lib/usage restent ceux de production.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-turn-usage-'));
process.env.AGENTHUB_DATA = DATA;
delete require.cache[require.resolve('../lib/usage')];
const usage = require('../lib/usage');
const modelSelection = require('../lib/model-selection');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`Fonction serveur introuvable : ${start}`);
  return serverSource.slice(from, to).trim();
}

const buildTurnSource = sourceBetween(
  'function buildTurn(',
  '/**\n * Lance un turn.'
);
const resumeTurnSource = sourceBetween(
  'function resumeTurn(',
  '// --- Turns hors fil'
);

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
class FixedDate extends Date {
  static now() { return NOW; }
}

function harness() {
  const running = new Map();
  const broadcasts = [];
  const updates = [];
  let currentConv = null;
  let goalDecisions = 0;
  const context = {
    Date: FixedDate,
    Promise,
    Object,
    Number,
    Boolean,
    String,
    Map,
    console,
    running,
    usage,
    modelSelection,
    secrets: {
      values: () => [],
      redactDeep: (value) => ({ ...value }),
      redact: (value) => value,
    },
    panel: { token: () => '' },
    notes: { projectOf: () => '/projet' },
    store: {
      update: (id, patch) => updates.push({ id, patch }),
      addItem: () => null,
      touchItem: () => null,
      get: () => currentConv,
      getTrigger: () => null,
    },
    broadcast: (message) => broadcasts.push(message),
    selectionState: (current, active) => modelSelection.state(current, active, { liveGrok: null }),
    setStatus: () => {},
    runnerResume: () => ({ finish() {} }),
    killTimers: new Map(),
    runs: { finish: () => {} },
    goals: { decide: () => { goalDecisions += 1; return { action: 'check' }; } },
    pursueGoal: async () => {},
    team: { forConv: () => null },
    produceReport: async () => {},
    proposeLesson: async () => {},
    notifyEnd: () => {},
    lastErrorText: () => null,
    dequeue: () => null,
    dispatchQueued: async () => {},
  };
  vm.runInNewContext(
    `${buildTurnSource}\n${resumeTurnSource}\nthis.extracted = { buildTurn, resumeTurn };`,
    context,
    { filename: 'server.js#turn-usage' }
  );
  Object.assign(context, context.extracted, {
    broadcasts,
    updates,
    setCurrent: (conv) => { currentConv = conv; },
    goalDecisions: () => goalDecisions,
  });
  return context;
}

function conv(id, provider = 'codex') {
  return {
    id,
    provider,
    model: 'test-model',
    folder: null,
    triggerId: null,
    totalCostUsd: 0,
  };
}

test('un turn repris conserve la durée antérieure au redémarrage', () => {
  const env = harness();
  const startedAt = NOW - 75_000;
  const current = conv('origine-reprise');
  const { handlers } = env.buildTurn(current, {}, startedAt);
  handlers.onItem({
    kind: 'result',
    isError: false,
    durationMs: 0,
    codexUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
  });

  const measured = usage.breakdown().conversations[current.id];
  assert.equal(measured.timeMs, 75_000);
});

test('plusieurs résultats gardent tous leurs tokens sans multiplier la durée', () => {
  const env = harness();
  const current = conv('resultats-multiples', 'claude');
  const { handlers } = env.buildTurn(current, {}, NOW - 9_000);
  handlers.onItem({
    kind: 'result', isError: false, durationMs: 9_000,
    modelUsage: { premier: { inputTokens: 10, outputTokens: 1, costUSD: 0.1 } },
  });
  handlers.onItem({
    kind: 'result', isError: false, durationMs: 9_000,
    modelUsage: { second: { inputTokens: 20, outputTokens: 2, costUSD: 0.2 } },
  });

  const measured = usage.breakdown().conversations[current.id];
  assert.equal(measured.timeMs, 9_000);
  assert.equal(measured.tokens, 33);
  assert.ok(Math.abs(measured.costUsd - 0.3) < 1e-9);
});

test('changer le prochain modèle pendant un turn ne réécrit pas le modèle de ce turn', () => {
  const env = harness();
  const current = conv('modele-immuable');
  current.model = 'ancien-modele';
  const selected = modelSelection.snapshot(current, {
    startedAt: new Date(NOW - 1_000).toISOString(),
    liveGrok: null,
  });
  const { handlers } = env.buildTurn(current, {}, NOW - 1_000, selected);

  // C'est exactement ce que fait le PATCH pendant que le CLI travaille.
  current.model = 'prochain-modele';
  handlers.onItem({
    kind: 'result', isError: false, durationMs: 1_000,
    codexUsage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 },
  });

  const saved = env.updates.find((entry) => entry.patch.lastModelSelection);
  assert.deepEqual(saved.patch.lastModelSelection, {
    models: ['ancien-modele'],
    source: 'requested',
  });
  const measured = usage.summary('all').providers.find((row) => row.provider === 'codex');
  assert.ok(measured.models.some((row) => row.model === 'ancien-modele'));
  assert.equal(measured.models.some((row) => row.model === 'prochain-modele'), false);
});

test('la reprise est enregistrée avant son drain immédiat et marque l usage finalisé', () => {
  const env = harness();
  const current = conv('drain-immediat');
  env.runnerResume = (record, resumed, handlers) => {
    assert.equal(env.running.has(resumed.id), true);
    handlers.onItem({
      kind: 'result', isError: false, durationMs: 0,
      codexUsage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 0 },
    });
    return { pid: record.pid };
  };

  env.resumeTurn(current, {
    pid: 123,
    startedAt: new Date(NOW - 30_000).toISOString(),
    modelSelection: modelSelection.snapshot(current, {
      startedAt: new Date(NOW - 30_000).toISOString(),
      liveGrok: null,
    }),
  });

  assert.equal(env.running.get(current.id).startedAt, NOW - 30_000);
  assert.equal(env.running.get(current.id).modelSelection.launchedModel, 'test-model');
  assert.equal(env.running.get(current.id).usageFinalized, true);
  assert.equal(usage.breakdown().conversations[current.id].timeMs, 30_000);
});

test('une reprise qui échoue ne laisse pas de faux turn actif', () => {
  const env = harness();
  const current = conv('reprise-refusee');
  env.runnerResume = () => { throw new Error('provider indisponible'); };

  assert.throws(
    () => env.resumeTurn(current, { pid: 456, startedAt: new Date(NOW).toISOString() }),
    /provider indisponible/
  );
  assert.equal(env.running.has(current.id), false);
});

test('une note de passation ne fait pas avancer un objectif actif', async () => {
  const env = harness();
  const current = { ...conv('passation-service'), queue: [], goal: { text: 'finir', round: 2, max: 6 } };
  env.setCurrent(current);
  const { handlers, done } = env.buildTurn(current, { isHandoff: true }, NOW - 1_000);

  handlers.onExit(0, '', false);
  await done;
  assert.equal(env.goalDecisions(), 0);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
