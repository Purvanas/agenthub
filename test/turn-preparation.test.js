'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareTurn } = require('../lib/turn-preparation');

function scenario() {
  let resume;
  const barrier = new Promise((resolve) => { resume = resolve; });
  const running = new Map();
  const started = [];
  const options = {
    id: 'conversation', running, exists: () => true,
    prepare: () => barrier,
    start: (checkpoint) => {
      started.push(checkpoint);
      running.set('conversation', { child: { pid: 42 }, stopped: false });
      return 'message';
    },
  };
  return { options, running, started, resume };
}

test('deux envois simultanés ne peuvent pas préparer deux CLIs pour le même fil', async () => {
  const s = scenario();
  const first = prepareTurn(s.options);
  assert.equal(s.running.get('conversation').preparing, true);
  await assert.rejects(prepareTurn(s.options), { statusCode: 409 });
  s.resume('checkpoint');
  assert.equal(await first, 'message');
  assert.deepEqual(s.started, ['checkpoint']);
  assert.equal(s.running.get('conversation').child.pid, 42);
});

test('interrompre avant la fin de l’instantané empêche le lancement du CLI', async () => {
  const s = scenario();
  let cancelled = false;
  const pending = prepareTurn({ ...s.options, onCancel: () => { cancelled = true; } });
  s.running.get('conversation').stopped = true;
  s.resume('checkpoint');
  assert.equal(await pending, null);
  assert.equal(cancelled, true);
  assert.equal(s.started.length, 0);
  assert.equal(s.running.size, 0);
});

test('supprimer le fil pendant sa préparation ne recrée pas de processus orphelin', async () => {
  const s = scenario();
  let exists = true;
  const pending = prepareTurn({ ...s.options, exists: () => exists });
  exists = false;
  s.running.delete('conversation');
  s.resume('checkpoint');
  assert.equal(await pending, null);
  assert.equal(s.started.length, 0);
});

test('un échec de préparation libère la réservation et signale l’erreur', async () => {
  const running = new Map();
  let reported = false;
  await assert.rejects(prepareTurn({
    id: 'c', running, exists: () => true,
    prepare: async () => { throw new Error('disque indisponible'); },
    start: () => assert.fail('ne doit pas démarrer'),
    onError: () => { reported = true; },
  }), /disque indisponible/);
  assert.equal(reported, true);
  assert.equal(running.size, 0);
});
