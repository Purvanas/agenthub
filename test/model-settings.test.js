'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function controller(options) {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/model-settings.js'), 'utf8'), { window });
  return window.AgentHubModelSettings.create(options);
}
const turn = () => new Promise(setImmediate);

test('modèle et effort sont sauvegardés ensemble dans l’ordre, malgré des changements rapides', async () => {
  const gates = [deferred(), deferred()];
  const calls = [];
  const saved = [];
  const c = controller({
    save: (id, pair) => { calls.push({ id, ...pair }); return gates[calls.length - 1].promise; },
    onSaved: (id, result) => saved.push(result),
  });
  c.update('a', { model: 'grok-4.6', effort: 'high' });
  c.update('a', { model: 'grok-4.7-build-fast', effort: 'low' });
  let ready = false;
  const waiting = c.wait('a').then(() => { ready = true; });
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(c.state('a').desired.model, 'grok-4.7-build-fast');
  gates[0].resolve({ model: 'grok-4.6' });
  await turn();
  assert.equal(calls.length, 2);
  assert.equal(ready, false, 'l’envoi attend le dernier changement');
  gates[1].resolve({ model: 'grok-4.7-build-fast' });
  await waiting;
  assert.equal(c.state('a').pending, false);
  assert.equal(c.state('a').desired, null);
  assert.equal(saved.length, 2);
  assert.deepEqual(calls, [
    { id: 'a', model: 'grok-4.6', effort: 'high' },
    { id: 'a', model: 'grok-4.7-build-fast', effort: 'low' },
  ]);
});

test('un changement refusé garde le choix souhaité et empêche un envoi ambigu', async () => {
  const c = controller({ save: async () => { throw new Error('réseau indisponible'); } });
  await assert.rejects(c.update('a', { model: 'sonnet', effort: 'high' }), /réseau/);
  await assert.rejects(c.wait('a'), /réseau/);
  assert.equal(c.state('a').desired.model, 'sonnet');
  c.cancelFailed('a');
  await c.wait('a');
  assert.equal(c.state('a').desired, null);
});

test('la sauvegarde d’un autre fil ne bloque pas la conversation affichée', async () => {
  const blocked = deferred();
  const c = controller({ save: (id) => id === 'a' ? blocked.promise : Promise.resolve({ model: 'opus' }) });
  const slow = c.update('a', { model: 'sonnet' });
  await c.update('b', { model: 'opus' });
  await c.wait('b');
  assert.equal(c.state('a').pending, true);
  assert.equal(c.state('b').pending, false);
  blocked.resolve({ model: 'sonnet' });
  await slow;
});

test('un choix plus récent réussi remplace une erreur précédente dans la même file', async () => {
  let call = 0;
  const c = controller({ save: async () => {
    if (++call === 1) throw new Error('ancien choix refusé');
    return { model: 'grok-4.6' };
  } });
  c.update('a', { model: 'absent', effort: 'high' });
  c.update('a', { model: 'grok-4.6', effort: 'medium' });
  await c.wait('a');
  assert.equal(c.state('a').error, null);
  assert.equal(c.state('a').desired, null);
});
