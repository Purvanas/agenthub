'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-usage-breakdown-'));
process.env.AGENTHUB_DATA = DATA;
const usage = require('../lib/usage');

test('la duree d un turn multi-modele n est comptee qu une fois', () => {
  usage.record({
    provider: 'claude',
    convId: 'c1',
    project: '/projet',
    item: {
      durationMs: 12_000,
      modelUsage: {
        grand: { inputTokens: 100, outputTokens: 10, costUSD: 0.2 },
        petit: { inputTokens: 50, outputTokens: 5, costUSD: 0.05 },
      },
    },
  });

  const metrics = usage.breakdown();
  assert.equal(metrics.conversations.c1.durationMs, 12_000);
  assert.equal(metrics.conversations.c1.timeMs, 12_000);
  assert.equal(metrics.projects['/projet'].durationMs, 12_000);
  assert.equal(metrics.conversations.c1.tokens, 165);
  assert.equal(metrics.conversations.c1.costUsd, 0.25);
  assert.equal(metrics.conversations.c1.costEstimated, true);
});

test('un resultat sans nouveau token conserve tout de meme sa duree', () => {
  const rows = usage.record({
    provider: 'codex',
    convId: 'sans-delta',
    project: '/projet',
    fallbackModel: 'codex-test',
    item: {
      durationMs: 4_000,
      codexUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].durationOnly, true);
  const metrics = usage.breakdown();
  assert.equal(metrics.conversations['sans-delta'].timeMs, 4_000);
  assert.equal(metrics.conversations['sans-delta'].tokens, 0);
});

test('les anciennes lignes retrouvent leur projet par le resolveur', () => {
  fs.appendFileSync(
    usage.LEDGER,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      provider: 'codex',
      convId: 'ancienne',
      model: 'm',
      inputTokens: 20,
      outputTokens: 5,
      costUsd: 0,
      costSource: 'inconnu',
    })}\n`
  );
  const metrics = usage.breakdown({
    resolve: (id) => (id === 'ancienne' ? { project: '/ancien-projet' } : null),
  });
  assert.equal(metrics.projects['/ancien-projet'].tokens, 25);
  assert.equal(metrics.projects['/ancien-projet'].unknownCost, true);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
