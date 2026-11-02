'use strict';

// Le panneau d'administration vu depuis agentHub.
//
// Ce module ne réimplémente pas ce que le panneau sait faire : il l'interroge. Ce qui compte
// donc, c'est son comportement quand l'autre côté ne répond pas comme prévu — éteint, sans
// jeton, ou refusant une route. Un onglet qui dit pourquoi vaut mieux qu'une page blanche.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-panel-'));
const TOKEN_FILE = path.join(DIR, 'service-token.json');
process.env.AGENTHUB_PANEL_TOKEN_FILE = TOKEN_FILE;

/** Un panneau de comédie : il vérifie le jeton et joue les réponses qu'on lui donne. */
const routes = new Map();
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, token: req.headers['x-service-token'] });
  const reply = routes.get(req.url);
  if (!reply) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    return res.end('{"error":"non autorisé"}');
  }
  res.writeHead(reply.status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(reply.body ?? {}));
});

let panel;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.AGENTHUB_PANEL_URL = `http://127.0.0.1:${server.address().port}`;
  panel = require('../lib/panel');
});

test.after(() => server.close());

test.beforeEach(() => {
  routes.clear();
  seen.length = 0;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'jeton-de-service-assez-long' }));
});

test('sans jeton, la fonctionnalite est eteinte et le dit', async () => {
  fs.rmSync(TOKEN_FILE, { force: true });
  assert.equal(panel.available(), false);
  assert.equal(panel.promptBlock(), '');
  const out = await panel.get('/api/pm2/list');
  assert.equal(out.ok, false);
  // Le message dit quoi faire, pas seulement que ça n'a pas marché.
  assert.match(out.error, /jeton de service/i);
  // Et rien n'est parti sur le réseau : inutile de déranger le panneau pour rien.
  assert.equal(seen.length, 0);
});

test('le jeton part dans l en-tete', async () => {
  routes.set('/api/pm2/list', { body: { processes: [] } });
  const out = await panel.get('/api/pm2/list');
  assert.equal(out.ok, true);
  assert.deepEqual(out.data, { processes: [] });
  assert.equal(seen[0].token, 'jeton-de-service-assez-long');
});

// Le jeton est relu à chaque appel : le faire tourner ne doit pas demander un redémarrage.
test('un jeton remplace est pris en compte sans redemarrage', async () => {
  routes.set('/api/pm2/list', { body: {} });
  await panel.get('/api/pm2/list');
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: 'un-tout-autre-jeton-de-service' }));
  await panel.get('/api/pm2/list');
  assert.equal(seen[1].token, 'un-tout-autre-jeton-de-service');
});

// 403 a un sens précis : la route n'est pas dans la liste blanche du panneau. Sans ce
// message, on cherche une demi-heure côté agentHub une permission qui se règle en face.
test('un 403 dit ou se regle le probleme', async () => {
  const out = await panel.get('/api/cloudflare/config');
  assert.equal(out.ok, false);
  assert.equal(out.status, 403);
  assert.match(out.error, /ALLOWED/);
});

test('un panneau eteint ne fait pas lever', async () => {
  const before = process.env.AGENTHUB_PANEL_URL;
  // Port fermé : `fetch` rejette, et ce rejet ne doit pas remonter.
  delete require.cache[require.resolve('../lib/panel')];
  process.env.AGENTHUB_PANEL_URL = 'http://127.0.0.1:1';
  const offline = require('../lib/panel');
  const out = await offline.get('/api/pm2/list');
  assert.equal(out.ok, false);
  assert.ok(out.error);
  process.env.AGENTHUB_PANEL_URL = before;
  delete require.cache[require.resolve('../lib/panel')];
  panel = require('../lib/panel');
});

// Le panneau interroge `apt` et `systemctl` : l'un peut échouer seul. Une page qui perd tout
// parce qu'un chiffre manque serait pire que pas de page.
test('un releve en echec n emporte pas les autres', async () => {
  routes.set('/api/system', { body: { cpu: 12 } });
  routes.set('/api/pm2/list', { body: { processes: ['a'] } });
  // `disk`, `services` et `sites` ne sont pas déclarés : le panneau de comédie répond 403.
  const out = await panel.overview();
  assert.deepEqual(out.system, { cpu: 12 });
  assert.deepEqual(out.pm2, { processes: ['a'] });
  assert.ok(out.disk.error, 'le relevé en échec porte son erreur');
  assert.ok(out.services.error);
  // Toutes les clés sont présentes : l'interface n'a pas à deviner ce qui manque.
  assert.deepEqual(Object.keys(out).sort(), ['disk', 'pm2', 'services', 'sites', 'system']);
});

test('le bloc de prompt annonce la lecture seule', () => {
  const block = panel.promptBlock();
  assert.match(block, /ADMINPANEL_TOKEN/);
  assert.match(block, /LECTURE SEULE/);
  // Le plus utile de tout le bloc : sans ça, un agent qui reçoit un 403 conclut à une panne.
  assert.match(block, /403[\s\S]*n'est pas une panne/);
});
