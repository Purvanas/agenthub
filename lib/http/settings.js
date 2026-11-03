'use strict';

function createSettingsChecks({ notify, mail, browserMcp, host, port, fetchImpl = fetch }) {
  return {
    async notify() {
      const config = notify.loadConfig();
      if (!config.enabled) return { ok: false, detail: 'Notifications désactivées' };
      const payload = notify.buildMessage({
        conv: {
          id: 'test',
          title: 'Essai depuis la page Paramètres',
          provider: 'agentHub',
          cwd: `${host}:${port}`,
        },
        outcome: 'done',
        appUrl: config.appUrl,
      });
      const request = notify.buildRequest(config, payload);
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(8000),
      });
      return response.ok
        ? { ok: true, detail: `Envoyée à ${request.url}` }
        : { ok: false, detail: `${request.url} a répondu ${response.status} ${response.statusText}` };
    },

    async mail(to) {
      const config = mail.config();
      if (!config.enabled) {
        return { ok: false, detail: 'Il manque au moins l’hôte SMTP ou l’adresse d’expéditeur' };
      }
      const target = (to || config.to || '').trim();
      if (!target) return { ok: false, detail: 'Aucun destinataire' };
      const sent = await mail.send({
        to: target,
        subject: 'agentHub — essai de configuration',
        text: 'Si tu lis ce message, l’envoi de mail est opérationnel.',
      });
      return sent.sent
        ? { ok: true, detail: `Envoyé à ${target}` }
        : { ok: false, detail: sent.reason };
    },

    async browser() {
      const config = browserMcp.config();
      if (!config.enabled) return { ok: false, detail: 'Navigateur désactivé, ou URL vide' };
      const response = await fetchImpl(config.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'agenthub-settings', version: '1' },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, detail: `${config.url} a répondu ${response.status} ${response.statusText}` };
      }
      const name = /"name"\s*:\s*"([^"]+)"/.exec(text);
      return { ok: true, detail: `Répond : ${name ? name[1] : 'serveur MCP'}` };
    },
  };
}

function registerSettingsRoutes({ app, asyncRoute, settings, checks }) {
  app.get('/api/settings', (req, res) => {
    res.json({ sections: settings.all() });
  });

  app.post('/api/settings/:section', (req, res) => {
    try {
      settings.save(req.params.section, req.body || {});
      res.json({ sections: settings.all() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/settings/:section', (req, res) => {
    try {
      settings.reset(req.params.section);
      res.json({ sections: settings.all() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/settings/:section/test', asyncRoute(async (req, res) => {
    const section = req.params.section;
    // Le test porte sur les valeurs affichées : on les persiste avant de sonder le service,
    // sans quoi un résultat positif pourrait valider une ancienne configuration.
    try {
      if (req.body && req.body.values) settings.save(section, req.body.values);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      if (section === 'notify') return res.json(await checks.notify());
      if (section === 'mail') return res.json(await checks.mail(req.body && req.body.to));
      if (section === 'browser') return res.json(await checks.browser());
      res.status(400).json({ error: 'Rien à tester pour cette section' });
    } catch (err) {
      res.json({ ok: false, detail: err.message });
    }
  }));
}

module.exports = { createSettingsChecks, registerSettingsRoutes };
