'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-auth-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/auth-requests')];
  return require('../lib/auth-requests');
}

test('une demande est persistante et une seconde remplace celle de la conversation', () => {
  const requests = fresh();
  requests.create({ convId: 'c1', service: 'Vercel', url: 'vercel.com/login', reason: 'deployer' });
  const last = requests.create({ convId: 'c1', service: 'Google', reason: 'lire Drive' });
  assert.equal(requests.list('pending').length, 1);
  assert.equal(last.url, 'https://www.google.com');
  assert.equal(requests.list('pending')[0].service, 'Google');
});

test('resoudre une demande la retire des attentes', () => {
  const requests = fresh();
  const row = requests.create({ convId: 'c1', reason: 'connexion requise' });
  assert.equal(requests.resolve(row.id).status, 'resolved');
  assert.equal(requests.list('pending').length, 0);
});

test('oublier une conversation retire ses demandes', () => {
  const requests = fresh();
  requests.create({ convId: 'c1', reason: 'connexion requise' });
  requests.create({ convId: 'c2', reason: 'autre connexion' });
  assert.equal(requests.forget('c1'), 1);
  assert.deepEqual(requests.list().map((r) => r.convId), ['c2']);
});

test('le prompt interdit les mots de passe et donne le canal agentHub', () => {
  const requests = fresh();
  const prompt = requests.promptBlock();
  assert.match(prompt, /AGENTHUB_AUTH_REQUEST_URL/);
  assert.match(prompt, /jamais son mot de passe/);
  assert.match(prompt, /ne la recopie jamais/);
});
