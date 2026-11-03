'use strict';

/**
 * Dossiers de la sidebar et secrets qui leur appartiennent.
 *
 * Les routes vivent ensemble parce que supprimer un dossier doit aussi oublier ses secrets.
 * Aucune réponse n'inclut une valeur de secret : `secrets.list` ne rend que les métadonnées.
 */
function registerFolderRoutes({ app, store, secrets, broadcast }) {
  function knownFolder(req, res) {
    const folder = store.folders().find((candidate) => candidate.id === req.params.id);
    if (!folder) {
      res.status(404).json({ error: 'Dossier introuvable' });
      return null;
    }
    return folder;
  }

  app.post('/api/folders', (req, res) => {
    const name = ((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom de dossier vide' });
    const folder = store.createFolder(name);
    broadcast({ type: 'folders', folders: store.folders() });
    res.status(201).json({ folder, folders: store.folders() });
  });

  // Doit précéder `:id`, sans quoi « order » serait traité comme un identifiant de dossier.
  app.patch('/api/folders/order', (req, res) => {
    const folders = store.reorderFolders((req.body && req.body.ids) || []);
    broadcast({ type: 'folders', folders });
    res.json({ folders });
  });

  app.patch('/api/folders/:id', (req, res) => {
    const name = ((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Nom de dossier vide' });
    if (!store.renameFolder(req.params.id, name)) {
      return res.status(404).json({ error: 'Dossier introuvable' });
    }
    broadcast({ type: 'folders', folders: store.folders() });
    res.json({ folders: store.folders() });
  });

  app.delete('/api/folders/:id', (req, res) => {
    store.removeFolder(req.params.id);
    secrets.forget(req.params.id);
    broadcast({ type: 'folders', folders: store.folders() });
    broadcast({ type: 'conversation', conversation: null });
    res.json({ folders: store.folders() });
  });

  app.get('/api/folders/:id/secrets', (req, res) => {
    if (!knownFolder(req, res)) return;
    res.json({ secrets: secrets.list(req.params.id), minLength: secrets.MIN_LENGTH });
  });

  app.post('/api/folders/:id/secrets/import', (req, res) => {
    if (!knownFolder(req, res)) return;
    const text = (req.body || {}).text;
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Rien à importer' });
    }
    const report = secrets.importEnv(req.params.id, text);
    res.json({ ...report, secrets: secrets.list(req.params.id) });
  });

  app.put('/api/folders/:id/secrets/:name', (req, res) => {
    if (!knownFolder(req, res)) return;
    const done = secrets.set(req.params.id, req.params.name, (req.body || {}).value);
    if (done.error) return res.status(400).json({ error: done.error });
    res.json({ secrets: secrets.list(req.params.id) });
  });

  app.delete('/api/folders/:id/secrets/:name', (req, res) => {
    if (!knownFolder(req, res)) return;
    if (!secrets.remove(req.params.id, req.params.name)) {
      return res.status(404).json({ error: 'Clé introuvable' });
    }
    res.json({ secrets: secrets.list(req.params.id) });
  });
}

module.exports = { registerFolderRoutes };
