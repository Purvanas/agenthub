'use strict';

/** Résout un projet donné directement ou par la conversation qui le porte. */
function resolveProject(body, store, source) {
  const convId = String((body && body.convId) || '');
  if (convId) {
    const conv = store.get(convId);
    if (!conv) return { error: 'Conversation inconnue' };
    const project = source.projectOf(conv);
    return project ? { project } : { error: "Cette conversation n'a pas de projet" };
  }
  const project = source.key((body && body.project) || '');
  return project ? { project } : { error: 'Projet manquant' };
}

/**
 * Plans, règles, mémoire et modèles de prompts.
 *
 * Ce sont les artefacts réutilisables d'un projet. Les modules de persistance font foi ;
 * cette couche ne décide que du projet visé, des codes HTTP et des diffusions temps réel.
 */
function registerPlanRoutes({
  app,
  store,
  plans,
  broadcast,
}) {
  const plansProject = (body) => resolveProject(body, store, plans);
  const broadcastPlans = (project) =>
    broadcast({ type: 'plans', project, sections: plans.list(project) });

  app.get('/api/plans', (req, res) => {
    const found = plansProject(req.query);
    if (found.error) return res.status(400).json({ error: found.error });
    res.json({ project: found.project, sections: plans.list(found.project) });
  });

  app.get('/api/plans/diagrams', (req, res) => {
    const found = plansProject(req.query);
    if (found.error) return res.status(400).json({ error: found.error });
    res.json({ project: found.project, diagrams: plans.diagrams(found.project) });
  });

  app.get('/api/plans/templates', (req, res) => {
    res.json({ diagrams: plans.DIAGRAMS });
  });

  app.get('/api/plans/doc', (req, res) => {
    const found = plansProject(req.query);
    if (found.error) return res.status(400).json({ error: found.error });
    try {
      const doc = plans.read(found.project, req.query.path);
      if (!doc) return res.status(404).json({ error: 'Document introuvable' });
      res.json({ project: found.project, doc });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/plans/doc', (req, res) => {
    const body = req.body || {};
    const found = plansProject(body);
    if (found.error) return res.status(400).json({ error: found.error });
    try {
      const doc = plans.write(found.project, body.path, body.content, {
        expectedVersion: body.expectedVersion,
      });
      broadcastPlans(found.project);
      res.json({ doc });
    } catch (err) {
      res.status(err.statusCode || 400).json({ error: err.message });
    }
  });

  app.post('/api/plans', (req, res) => {
    const found = plansProject(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    try {
      const doc = plans.create(found.project, req.body || {});
      broadcastPlans(found.project);
      res.status(201).json({ doc });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
}

function registerProjectKnowledgeRoutes({
  app,
  store,
  notes,
  rules,
  memory,
  prompts,
  settings,
  fs,
  path,
  broadcast,
}) {
  const notesProject = (body) => resolveProject(body, store, notes);
  const broadcastRules = (project) =>
    broadcast({ type: 'rules', project, rules: rules.list(project) });
  const broadcastPrompts = () => broadcast({ type: 'prompts', prompts: prompts.list() });

  app.get('/api/rules', (req, res) => {
    const found = notesProject(req.query);
    if (found.error) return res.status(400).json({ error: found.error });
    const name = String(req.query.name || '').trim();
    if (name) {
      const rule = rules.find(found.project, name);
      // L'absence est une réponse métier, pas une panne : les agents appellent cette route
      // avec `curl -f` avant d'agir et doivent pouvoir continuer lorsqu'aucune règle n'existe.
      return res.json(
        rule
          ? { found: true, rule: { name: rule.name, when: rule.when, body: rule.body } }
          : { found: false, name, message: `Aucune règle « ${name} » sur ce projet.` }
      );
    }
    res.json({ project: found.project, rules: rules.list(found.project) });
  });

  app.post('/api/rules', (req, res) => {
    const found = notesProject(req.body);
    if (found.error) return res.status(400).json({ error: found.error });
    try {
      const rule = rules.create(found.project, req.body || {});
      broadcastRules(found.project);
      res.status(201).json({ rule });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/rules/:id', (req, res) => {
    try {
      const rule = rules.update(req.params.id, req.body || {});
      if (!rule) return res.status(404).json({ error: 'Règle introuvable' });
      broadcastRules(rule.project);
      res.json({ rule });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/rules/:id', (req, res) => {
    const rule = rules.get(req.params.id);
    if (!rules.remove(req.params.id)) {
      return res.status(404).json({ error: 'Règle introuvable' });
    }
    broadcastRules(rule.project);
    res.status(204).end();
  });

  app.get('/api/memory', (req, res) => {
    const found = notesProject(req.query);
    if (found.error) return res.status(400).json({ error: found.error });
    res.json({ project: found.project, entries: memory.list(found.project) });
  });

  app.post('/api/memory/:id/:decision', (req, res) => {
    const row = memory.get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Fiche introuvable' });
    const decision = req.params.decision === 'keep' ? 'kept' : 'dismissed';

    let file = null;
    // `docs/solutions` est une convention opt-in du dépôt. Ne jamais créer ce dossier ni
    // écraser un homonyme : la fiche conservée dans `data/` reste la source de vérité.
    if (decision === 'kept' && (settings.read('memory') || {}).writeFile && row.project) {
      const dir = path.join(row.project, 'docs', 'solutions');
      try {
        if (fs.statSync(dir).isDirectory()) {
          const target = path.join(dir, `${memory.slug(req.body?.title || row.title)}.md`);
          fs.writeFileSync(target, memory.markdown({ ...row, ...(req.body || {}) }), { flag: 'wx' });
          file = target;
        }
      } catch {
        // Le fichier est un bonus : la fiche reste conservée dans `data/`.
      }
    }

    const updated = memory.decide(row.id, decision, { ...(req.body || {}), file });
    broadcast({ type: 'memory', project: updated.project, entries: memory.list(updated.project) });
    res.json({ entry: updated });
  });

  app.delete('/api/memory/:id', (req, res) => {
    const row = memory.get(req.params.id);
    if (!memory.remove(req.params.id)) {
      return res.status(404).json({ error: 'Fiche introuvable' });
    }
    broadcast({ type: 'memory', project: row.project, entries: memory.list(row.project) });
    res.status(204).end();
  });

  app.get('/api/prompts', (req, res) => {
    res.json({ prompts: prompts.list() });
  });

  app.post('/api/prompts', (req, res) => {
    try {
      const row = prompts.create(req.body || {});
      broadcastPrompts();
      res.status(201).json({ prompt: row });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.patch('/api/prompts/:id', (req, res) => {
    try {
      const row = prompts.update(req.params.id, req.body || {});
      if (!row) return res.status(404).json({ error: 'Modèle introuvable' });
      broadcastPrompts();
      res.json({ prompt: row });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/prompts/:id/used', (req, res) => {
    if (prompts.used(req.params.id)) broadcastPrompts();
    res.status(204).end();
  });

  app.delete('/api/prompts/:id', (req, res) => {
    if (!prompts.remove(req.params.id)) {
      return res.status(404).json({ error: 'Modèle introuvable' });
    }
    broadcastPrompts();
    res.status(204).end();
  });
}

module.exports = { registerPlanRoutes, registerProjectKnowledgeRoutes, resolveProject };
