'use strict';

/**
 * Routes des comptes fournisseurs et des connexions externes.
 *
 * Leur état transitoire (la demande d'authentification ouverte dans le navigateur humain)
 * reste privé à ce domaine. Le point d'entrée injecte les adaptateurs et les deux actions qui
 * relancent une conversation ; ce module ne dépend donc ni du WebSocket ni du runner global.
 */
function registerConnectionsRoutes({
  app,
  asyncRoute,
  providers,
  accounts,
  login,
  googleOauth,
  remoteBrowser,
  authRequests,
  watchBrowser,
  store,
  running,
  enqueue,
  dispatch,
  broadcast,
  logger = console,
}) {
  let activeAuthRequestId = null;

  function knownProvider(req, res) {
    if (providers.has(req.params.provider)) return true;
    res.status(400).json({ error: 'Provider inconnu' });
    return false;
  }

  function onLoginChange(provider, view) {
    broadcast({ type: 'login', provider, login: view });
    if (view.state !== 'done') return;
    accounts.invalidate(provider);
    accounts.get(provider).then((account) => {
      broadcast({ type: 'account', provider, account });
    });
  }

  function googleView() {
    return {
      config: googleOauth.publicConfiguration(),
      accounts: googleOauth.accounts(),
    };
  }

  app.get('/api/accounts', asyncRoute(async (req, res) => {
    if (req.query.refresh) accounts.invalidate();
    res.json({ accounts: await accounts.all(providers) });
  }));

  app.get('/api/accounts/:provider/login', (req, res) => {
    if (!knownProvider(req, res)) return;
    res.json({ login: login.status(req.params.provider) });
  });

  app.post('/api/accounts/:provider/login', (req, res) => {
    if (!knownProvider(req, res)) return;
    try {
      res.status(201).json({ login: login.start(req.params.provider, onLoginChange) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/accounts/:provider/login/code', (req, res) => {
    if (!knownProvider(req, res)) return;
    try {
      res.json({ login: login.submitCode(req.params.provider, (req.body || {}).code) });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  app.delete('/api/accounts/:provider/login', (req, res) => {
    if (!knownProvider(req, res)) return;
    login.clear(req.params.provider);
    res.json({ login: login.status(req.params.provider) });
  });

  app.post('/api/accounts/:provider/logout', asyncRoute(async (req, res) => {
    if (!knownProvider(req, res)) return;
    const provider = req.params.provider;
    try {
      await login.logout(provider);
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    login.clear(provider);
    accounts.invalidate(provider);
    const account = await accounts.get(provider);
    broadcast({ type: 'account', provider, account });
    res.json({ account });
  }));

  app.get('/api/connections/google', (req, res) => {
    res.json({ google: googleView() });
  });

  app.post('/api/connections/google/config', (req, res) => {
    try {
      googleOauth.configure(req.body || {});
      const google = googleView();
      broadcast({ type: 'google-accounts', google });
      res.status(201).json({ google });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/connections/google/start', (req, res) => {
    try {
      res.status(201).json(googleOauth.begin());
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  app.get('/api/connections/google/callback', asyncRoute(async (req, res) => {
    let title = 'Compte Google connecte';
    let message = 'Tu peux fermer cette fenetre et revenir dans agentHub.';
    let ok = true;
    try {
      if (req.query.error) throw new Error(String(req.query.error));
      await googleOauth.complete(req.query.code, req.query.state);
      broadcast({ type: 'google-accounts', google: googleView() });
    } catch (err) {
      ok = false;
      title = 'Connexion Google impossible';
      message = err.message;
    }
    res.type('html').send(`<!doctype html><html lang="fr"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${title}</title><body style="font:16px system-ui;background:#1f1e1d;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0">
      <main style="max-width:560px;padding:32px;text-align:center"><h1>${title}</h1>
      <p style="color:${ok ? '#aaa' : '#ef8060'}">${String(message).replace(/[<&]/g, '')}</p>
      <button onclick="window.close()" style="padding:10px 18px">Fermer</button></main></body></html>`);
  }));

  app.post('/api/connections/google/api/:id', asyncRoute(async (req, res) => {
    try {
      const upstream = await googleOauth.apiRequest(req.params.id, req.body || {});
      res.status(upstream.status);
      res.type(upstream.contentType || 'application/json').send(upstream.text);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }));

  app.delete('/api/connections/google/:id', (req, res) => {
    if (!googleOauth.disconnect(req.params.id)) {
      return res.status(404).json({ error: 'Compte Google introuvable' });
    }
    const google = googleView();
    broadcast({ type: 'google-accounts', google });
    res.json({ google });
  });

  app.get('/api/connections/browser', asyncRoute(async (req, res) => {
    res.json({
      browser: await remoteBrowser.state(),
      requests: authRequests.list('pending'),
      activeRequestId: activeAuthRequestId,
    });
  }));

  app.post('/api/connections/requests', (req, res) => {
    const body = req.body || {};
    if (!store.get(String(body.convId || ''))) {
      return res.status(404).json({ error: 'Conversation inconnue' });
    }
    try {
      const request = authRequests.create(body);
      const notice = store.addItem(request.convId, {
        kind: 'notice',
        text: `${request.service} demande une connexion humaine : ${request.reason}`,
        authRequestId: request.id,
      });
      if (notice) broadcast({ type: 'item', convId: request.convId, item: notice });
      broadcast({ type: 'auth-request', request });
      res.status(201).json({ request });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/connections/browser', asyncRoute(async (req, res) => {
    try {
      const browser = await remoteBrowser.start((req.body || {}).url);
      const requested = String((req.body || {}).requestId || '');
      activeAuthRequestId = authRequests.list('pending').some((request) => request.id === requested)
        ? requested
        : null;
      broadcast({ type: 'remote-browser', browser });
      res.status(201).json({ browser });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }));

  // Vue du navigateur que l'agent manipule via MCP. Il est distinct du navigateur humain
  // ci-dessus, réservé à la saisie d'identifiants dans un profil persistant.
  app.get('/api/browser/live', asyncRoute(async (req, res) => {
    try {
      res.json({ tab: await watchBrowser.where() });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }));

  app.get('/api/browser/live/frame', asyncRoute(async (req, res) => {
    try {
      const shot = await watchBrowser.frame();
      res.set('Cache-Control', 'no-store');
      if (shot.stale) res.set('X-Frame-Stale', '1');
      res.type(shot.mime).send(shot.buffer);
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }));

  app.get('/api/connections/browser/frame', asyncRoute(async (req, res) => {
    try {
      const frame = await remoteBrowser.screenshot();
      res.set('Cache-Control', 'no-store');
      res.type('jpg').send(frame);
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }));

  app.post('/api/connections/browser/action', asyncRoute(async (req, res) => {
    const body = req.body || {};
    try {
      let browser;
      if (body.action === 'navigate') browser = await remoteBrowser.navigate(body.url);
      else if (body.action === 'click') browser = await remoteBrowser.click(body.x, body.y);
      else if (body.action === 'type') browser = await remoteBrowser.type(body.text);
      else if (body.action === 'key') browser = await remoteBrowser.key(body.key);
      else if (body.action === 'scroll') browser = await remoteBrowser.scroll(body.deltaY);
      else return res.status(400).json({ error: 'Action de navigateur inconnue' });
      res.json({ browser });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  }));

  app.delete('/api/connections/browser', asyncRoute(async (req, res) => {
    const browser = await remoteBrowser.close();
    const request =
      activeAuthRequestId && req.query.complete !== '0'
        ? authRequests.resolve(activeAuthRequestId)
        : null;
    activeAuthRequestId = null;
    broadcast({ type: 'remote-browser', browser });
    if (request) {
      const conv = store.get(request.convId);
      if (conv) {
        const prompt =
          `La connexion humaine a ${request.service} vient d'etre terminee dans le navigateur ` +
          `du serveur. Reprends maintenant ce qui etait bloque : ${request.reason}`;
        if (running.has(conv.id)) enqueue(conv, prompt, null);
        else dispatch(conv, prompt, null, { authResume: true }).catch((err) =>
          logger.error(`reprise apres connexion impossible : ${err.message}`)
        );
      }
      broadcast({ type: 'auth-request-resolved', request });
    }
    res.json({ browser, request });
  }));
}

module.exports = { registerConnectionsRoutes };
