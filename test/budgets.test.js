'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-budgets-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/budgets')];
  return { budgets: require('../lib/budgets'), dir };
}

test('une cible a une règle persistante avec plusieurs seuils', () => {
  const { budgets } = fresh();
  const rule = budgets.saveRule({
    scope: 'project',
    target: '/projet',
    limits: { timeMs: 60_000, tokens: 50_000, costUsd: 2.5 },
  });
  assert.equal(budgets.listRules()[0].id, rule.id);
  assert.deepEqual(budgets.listRules()[0].limits, {
    timeMs: 60_000,
    tokens: 50_000,
    costUsd: 2.5,
  });

  const updated = budgets.saveRule({
    scope: 'project',
    target: '/projet',
    limits: { tokens: 100_000 },
  });
  assert.equal(updated.id, rule.id, 'la même cible ne crée pas deux budgets concurrents');
  assert.equal(budgets.listRules().length, 1);
});

test('les dépassements sont signalés sans action automatique', () => {
  const { budgets } = fresh();
  const rule = budgets.saveRule({
    scope: 'conversation',
    target: 'c1',
    limits: { timeMs: 1000, tokens: 100, costUsd: 1 },
  });
  const found = budgets.alerts({
    conversations: { c1: { timeMs: 1500, tokens: 90, costUsd: 2 } },
    projects: {},
  });
  assert.deepEqual(found.map((alert) => alert.metric), ['costUsd', 'timeMs']);
  assert.ok(found.every((alert) => alert.ruleId === rule.id && alert.state === 'active'));
  assert.equal(found.find((alert) => alert.metric === 'costUsd').costEstimated, true);
});

test('une alerte peut être masquée ou repoussée sans supprimer sa règle', () => {
  const { budgets } = fresh();
  budgets.saveRule({ scope: 'project', target: '/p', limits: { tokens: 10 } });
  const metrics = { conversations: {}, projects: { '/p': { tokens: 20 } } };
  const active = budgets.alerts(metrics, new Date('2026-01-01T10:00:00Z'))[0];

  budgets.dismiss(active.id);
  assert.equal(budgets.alerts(metrics, new Date('2026-01-01T10:01:00Z'))[0].state, 'dismissed');

  budgets.snooze(active.id, '2099-01-02T10:00:00Z');
  assert.equal(budgets.alerts(metrics, new Date('2099-01-01T11:00:00Z'))[0].state, 'snoozed');
  assert.equal(budgets.alerts(metrics, new Date('2099-01-03T10:00:00Z'))[0].state, 'active');
  assert.equal(budgets.listRules().length, 1);
});

test('les seuils invalides sont refusés et une règle se supprime explicitement', () => {
  const { budgets } = fresh();
  assert.throws(
    () => budgets.saveRule({ scope: 'project', target: '/p', limits: { tokens: 0 } }),
    /Seuil/
  );
  const rule = budgets.saveRule({ scope: 'project', target: '/p', limits: { tokens: 10 } });
  assert.equal(budgets.removeRule(rule.id), true);
  assert.equal(budgets.removeRule(rule.id), false);
});

test('déplacer une règle ne peut pas créer deux budgets sur la même cible', () => {
  const { budgets } = fresh();
  const first = budgets.saveRule({ scope: 'project', target: '/a', limits: { tokens: 10 } });
  budgets.saveRule({ scope: 'project', target: '/b', limits: { tokens: 20 } });
  assert.throws(
    () => budgets.saveRule({
      id: first.id, scope: 'project', target: '/b', limits: { tokens: 30 },
    }),
    /déjà un budget/
  );
  assert.equal(budgets.listRules().length, 2);
});
