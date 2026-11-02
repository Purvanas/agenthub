'use strict';

// Ce qui est testé ici, c'est le découpage des réponses du service Playwright — la partie
// qui se trompe en silence. Le reste (aller chercher une image sur le réseau) se vérifie
// contre le vrai service, pas contre un faux qui répondrait toujours ce qu'on attend.

const test = require('node:test');
const assert = require('node:assert');

const watch = require('../lib/watch-browser');

test('une réponse SSE se lit comme du JSON', () => {
  // Playwright répond en `text/event-stream` même pour une requête unique.
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(watch.parseSse(sse).result, { ok: true });
});

test('une réponse JSON ordinaire se lit aussi', () => {
  assert.deepEqual(watch.parseSse('{"result":{"ok":1}}').result, { ok: 1 });
});

test('une réponse illisible rend null au lieu de jeter', () => {
  // Un service qui bafouille ne doit pas faire tomber la vue.
  assert.equal(watch.parseSse('pas du json'), null);
  assert.equal(watch.parseSse(''), null);
});

test("l'image est extraite parmi les autres morceaux", () => {
  const content = [
    { type: 'text', text: '### Result' },
    { type: 'image', mimeType: 'image/jpeg', data: 'AAAA' },
  ];
  assert.deepEqual(watch.pickImage(content), { mime: 'image/jpeg', data: 'AAAA' });
  assert.equal(watch.pickImage([{ type: 'text', text: 'rien' }]), null);
  assert.equal(watch.pickImage(null), null);
});

test("l'onglet courant se lit dans la liste markdown", () => {
  const text = [
    '### Result',
    '- 0: [Autre page](https://exemple.test/autre)',
    '- 1: (current) [agentHub](http://127.0.0.1:3901/)',
  ].join('\n');
  // Seule la ligne marquée courante compte : c'est celle que la capture montre.
  assert.deepEqual(watch.pickTab(text), {
    title: 'agentHub',
    url: 'http://127.0.0.1:3901/',
  });
});

test('un onglet sans titre garde son adresse', () => {
  assert.deepEqual(watch.pickTab('- 0: (current) [](about:blank)'), {
    title: '',
    url: 'about:blank',
  });
});

test('sans onglet courant, rien n’est inventé', () => {
  assert.equal(watch.pickTab('- 0: [Une page](https://exemple.test/)'), null);
  assert.equal(watch.pickTab('### Result'), null);
  assert.equal(watch.pickTab(''), null);
});
