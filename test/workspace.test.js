'use strict';

const test = require('node:test');
const assert = require('node:assert');
const workspace = require('../lib/workspace');

const conversations = [
  {
    id: 'ask', title: 'Décision', provider: 'claude', status: 'working',
    cwd: '/data/worktrees/ask',
    project: '/projet', branch: 'agenthub/ask',
    updatedAt: '2026-11-03T12:00:00Z',
  },
  {
    id: 'ko', title: 'Échec', provider: 'codex', status: 'error', cwd: '/projet',
    updatedAt: '2026-11-03T11:00:00Z',
  },
  {
    id: 'archive', title: 'Ancienne', provider: 'claude', status: 'done', cwd: '/projet',
    archived: true, updatedAt: '2026-11-02T11:00:00Z',
  },
];

test('a traiter priorise les questions et exclut les archives', () => {
  const view = workspace.attention({
    conversations,
    asks: [{ id: 'q1', convId: 'ask', question: 'On publie ?' }],
    silent: [{ convId: 'ask', idleMs: 700_000 }],
  });
  assert.deepEqual(view.items.map((row) => row.id), ['ask', 'ko']);
  assert.equal(view.items[0].primary, 'ask');
  assert.deepEqual(view.items[0].reasons, ['ask', 'silent', 'working']);
  assert.equal(view.counts.total, 2);
  assert.equal(view.counts.done, 0);
});

test('les projets replient les worktrees sur leur depot et résument les index', () => {
  const projects = workspace.projectSummaries({
    folders: [{ id: 'f1', name: 'Mon projet', cwd: '/projet' }],
    conversations,
    notesFor: () => [{ status: 'todo' }, { status: 'done' }],
    plansFor: () => [{ docs: [{ status: 'doing' }, { status: null }] }],
    usage: { '/projet': { tokens: 123, costUsd: 0.4 } },
  });
  assert.equal(projects.length, 1);
  assert.equal(projects[0].name, 'Mon projet');
  assert.deepEqual(projects[0].conversations, {
    total: 3, active: 2, archived: 1, byStatus: { working: 1, error: 1, done: 1 },
  });
  assert.deepEqual(projects[0].notes, { total: 2, todo: 1, doing: 0, done: 1 });
  assert.deepEqual(projects[0].plans, { total: 2, byStatus: { doing: 1, autre: 1 } });
  assert.equal(projects[0].usage.tokens, 123);
});

test('un projet historique survit par son journal de consommation', () => {
  const projects = workspace.projectSummaries({
    folders: [],
    conversations: [],
    usage: { '/supprimé': { tokens: 50, costUsd: 1 } },
  });
  assert.equal(projects[0].key, '/supprimé');
  assert.equal(projects[0].conversations.total, 0);
  assert.equal(projects[0].usage.costUsd, 1);
});

test('le service rend overview, detail projet et inventaire dans des formes stables', async () => {
  const service = workspace.create({
    listConversations: () => conversations,
    listFolders: () => [{ id: 'f1', name: 'Projet', cwd: '/projet' }],
    listAsks: () => [],
    listSilent: () => [],
    notesFor: () => [{ id: 'n1', status: 'doing' }],
    plansFor: () => [],
    usageBreakdown: () => ({ conversations: {}, projects: { '/projet': { tokens: 10 } } }),
    inventoryWorktrees: async () => [
      { id: 'wt1', repo: '/projet', orphan: true, state: { dirty: 1, ahead: 0 } },
    ],
    landmarksFor: async () => [{ path: 'README.md' }],
  });
  assert.equal(service.overview().projects[0].key, '/projet');
  assert.deepEqual((await service.worktrees()).counts, {
    total: 1, orphan: 1, dirty: 1, ahead: 0,
  });
  const detail = await service.project('/projet/');
  assert.equal(detail.project.key, '/projet');
  assert.equal(detail.worktrees[0].id, 'wt1');
  assert.deepEqual(detail.landmarks, [{ path: 'README.md' }]);
});

test('une clé projet inconnue est refusée avant tout scan de documents', async () => {
  let scans = 0;
  const service = workspace.create({
    listConversations: () => [{ id: 'c1', cwd: '/projet' }], listFolders: () => [],
    notesFor: () => { scans += 1; return []; },
    plansFor: () => { scans += 1; return []; },
  });
  assert.equal(await service.project('/autre-dossier'), null);
  assert.equal(scans, 0);
});
