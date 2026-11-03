'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-workspace-api-'));
process.env.AGENTHUB_DATA = DIR;
const budgets = require('../lib/budgets');
const { createRoutes } = require('../lib/workspace-routes');
const meta = { id: 'c1', title: 'Test', cwd: '/project', project: '/project' };
const store = {
  list: () => [meta], getMeta: (id) => id === 'c1' ? meta : null,
  folders: () => [],
};
const app = express();
app.use(express.json());
const attention = { items: [{ ...meta, primary: 'done' }], counts: { total: 1 } };
app.use('/api/workspace', createRoutes({
  express,
  asyncRoute: (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
  store,
  workspace: {
    overview: () => ({ attention, projects: [] }), attention: () => attention,
    project: () => null, worktrees: async () => ({ items: [], counts: {} }),
  },
  budgets, worktrees: {}, running: new Map(), broadcast: () => {}, providers: new Set(['claude']),
  notes: { projectOf: (row) => row.project },
  usage: { breakdown: () => ({ conversations: { c1: { tokens: 100 } }, projects: {} }) },
}));
app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ error: err.message }));
let server;
let base;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(DIR, { recursive: true, force: true });
});

test('un budget saisi par HTTP produit une alerte puis un accusé persistant', async () => {
  const saved = await fetch(`${base}/api/workspace/budgets`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'conversation', target: 'c1', limits: { tokens: 50 } }),
  });
  assert.equal(saved.status, 200);
  const overview = await fetch(`${base}/api/workspace`).then((res) => res.json());
  assert.equal(overview.attention.counts.total, 1);
  assert.equal(overview.alerts[0].state, 'active');
  await fetch(`${base}/api/workspace/alerts/dismiss`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: overview.alerts[0].id }),
  });
  const refreshed = await fetch(`${base}/api/workspace/attention`).then((res) => res.json());
  assert.equal(refreshed.alerts[0].state, 'dismissed');
});

test('les cibles absentes et seuils invalides sont refusés avant sauvegarde', async () => {
  for (const [target, limits, status] of [['absent', { tokens: 1 }, 404], ['c1', { tokens: -1 }, 400]]) {
    const response = await fetch(`${base}/api/workspace/budgets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'conversation', target, limits }),
    });
    assert.equal(response.status, status);
  }
});

test('un chemin arbitraire ne peut pas devenir une branche à reprendre', async () => {
  const response = await fetch(`${base}/api/workspace/worktrees/..%2Foutside/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"claude"}',
  });
  assert.equal(response.status, 404);
});
