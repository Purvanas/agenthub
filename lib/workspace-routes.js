'use strict';

// API de l'espace de travail. L'orchestrateur CLI reste dans server.js ; ces routes
// composent des services injectés et ne démarrent jamais un agent d'elles-mêmes.
const { review } = require('./worktree-review');

function createRoutes({ express, asyncRoute, store, workspace, budgets, worktrees, usage,
  notes, running, broadcast, providers }) {
  const router = express.Router();
  let cachedOverview = null;
  let overviewAt = 0;
  let overviewVersion = '';
  const gitWrites = new Set();
  const invalidate = () => { overviewAt = 0; broadcast({ type: 'workspace' }); };
  const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const resolve = (id) => {
    const meta = store.getMeta(id);
    return meta ? { ...meta, project: notes.projectOf(meta) } : null;
  };
  const metrics = () => {
    const measured = usage.breakdown({ resolve });
    // La durée d'un turn en cours est déjà observable avant son relevé de consommation.
    // Ne pas la rajouter si son résultat a justement été journalisé avant onExit.
    for (const [id, active] of running) {
      if (!active.startedAt || active.usageFinalized) continue;
      const meta = store.getMeta(id);
      if (!meta) continue;
      const elapsed = Math.max(0, Date.now() - active.startedAt);
      const project = notes.projectOf(meta);
      for (const [bucket, key] of [[measured.conversations, id], [measured.projects, project]]) {
        if (!key) continue;
        const value = bucket[key] || (bucket[key] = { tokens: 0, costUsd: 0, durationMs: 0, timeMs: 0 });
        value.durationMs = (value.durationMs || 0) + elapsed;
        value.timeMs = (value.timeMs || 0) + elapsed;
      }
    }
    return measured;
  };

  router.get('/', asyncRoute(async (req, res) => {
    const version = store.list().map((conv) => `${conv.id}:${conv.updatedAt}:${conv.archived}`).join('|');
    if (!cachedOverview || version !== overviewVersion || Date.now() - overviewAt > 5000) {
      cachedOverview = await workspace.overview();
      overviewAt = Date.now();
      overviewVersion = version;
    }
    res.json({ ...cachedOverview, alerts: budgets.alerts(metrics()), rules: budgets.listRules() });
  }));
  router.get('/attention', (req, res) => res.json({
    attention: workspace.attention(), alerts: budgets.alerts(metrics()),
  }));

  router.get('/projects', asyncRoute(async (req, res) => {
    const key = String(req.query.key || '');
    const data = await workspace.project(key);
    if (!data) throw fail('Projet introuvable', 404);
    res.json(data);
  }));

  router.get('/worktrees', asyncRoute(async (req, res) => res.json(await workspace.worktrees())));
  async function entryOf(id) {
    const data = await workspace.worktrees();
    const entry = data.items.find((row) => row.id === id);
    if (!entry) throw fail('Branche introuvable', 404);
    return entry;
  }

  router.get('/worktrees/:id/diff', asyncRoute(async (req, res) => {
    res.json(await review(await entryOf(req.params.id)));
  }));

  router.post('/worktrees/:id/resume', asyncRoute(async (req, res) => {
    const entry = await entryOf(req.params.id);
    const provider = String((req.body || {}).provider || 'claude');
    if (!providers.has(provider)) throw fail('Agent inconnu');
    if (gitWrites.has(entry.repo)) throw fail('Une opération Git est déjà en cours sur ce projet.', 409);
    gitWrites.add(entry.repo);
    let conv;
    try {
      conv = store.create({
        provider, cwd: entry.repo,
        folder: (store.folderForCwd(entry.repo) || {}).id || null,
        title: `Reprise · ${entry.branch}`, titleAuto: false,
      });
      const attached = await worktrees.resume(entry, { convId: conv.id });
      store.update(conv.id, { cwd: attached.cwd, worktree: attached.worktree });
      invalidate();
      broadcast({ type: 'folders', folders: store.folders() });
      broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === conv.id) });
      res.status(201).json({ conversation: store.getMeta(conv.id) });
    } catch (err) {
      if (conv) store.remove(conv.id);
      throw err;
    } finally {
      gitWrites.delete(entry.repo);
    }
  }));

  router.post('/worktrees/:id/merge', asyncRoute(async (req, res) => {
    const entry = await entryOf(req.params.id);
    if (entry.owners.some((id) => running.has(id))) throw fail('Un agent travaille sur cette branche.', 409);
    if (gitWrites.has(entry.repo)) throw fail('Une opération Git est déjà en cours sur ce projet.', 409);
    gitWrites.add(entry.repo);
    try {
      const done = await worktrees.merge(entry.worktree);
      invalidate();
      res.json({ merged: done });
    } finally {
      gitWrites.delete(entry.repo);
    }
  }));

  router.get('/budgets', (req, res) => res.json({ rules: budgets.listRules(), alerts: budgets.alerts(metrics()) }));
  router.post('/budgets', (req, res) => {
    const spec = req.body || {};
    if (spec.scope === 'conversation' && !store.getMeta(spec.target)) throw fail('Conversation introuvable', 404);
    let rule;
    try { rule = budgets.saveRule(spec); } catch (err) { throw fail(err.message); }
    invalidate();
    res.json({ rule });
  });
  router.delete('/budgets/:id', (req, res) => {
    budgets.removeRule(req.params.id);
    invalidate();
    res.json({ deleted: true });
  });
  router.post('/alerts/dismiss', (req, res) => {
    budgets.dismiss((req.body || {}).id);
    invalidate();
    res.json({ dismissed: true });
  });
  router.post('/alerts/snooze', (req, res) => {
    budgets.snooze((req.body || {}).id, new Date(Date.now() + 3600_000).toISOString());
    invalidate();
    res.json({ snoozed: true });
  });
  return router;
}

module.exports = { createRoutes };
