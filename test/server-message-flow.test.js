'use strict';

// Régressions des transitions serveur qui ne vivent dans aucun module isolé. Comme le test de
// consommation, on charge les vraies fonctions de server.js dans un contexte sans ouvrir de
// port, sans minuteur et sans lancer de CLI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createQueuedDispatcher } = require('../lib/queued-dispatch');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from === -1 || to === -1) throw new Error(`Source serveur introuvable : ${start}`);
  return source.slice(from, to).trim();
}

function queueHarness() {
  const updates = [];
  const context = {
    store: {
      get: () => context.conv,
      update: (id, patch) => updates.push({ id, patch }),
    },
    broadcastQueue: () => {},
    dequeue(conv, id) {
      const index = conv.queue.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const [entry] = conv.queue.splice(index, 1);
      return entry;
    },
    dispatch: async () => null,
    conv: null,
  };
  const api = createQueuedDispatcher({
    store: context.store,
    broadcastQueue: context.broadcastQueue,
    dequeue: context.dequeue,
    dispatch: (...args) => context.dispatch(...args),
  });
  return { ...api, context, updates };
}

test('un message en file retrouve sa position si la préparation échoue', async () => {
  const env = queueHarness();
  const first = { id: 'a', text: 'à envoyer', images: [] };
  const second = { id: 'b', text: 'après', images: [] };
  env.context.conv = { id: 'c1', queue: [first, second] };
  env.context.dispatch = async () => { throw new Error('instantané impossible'); };

  await assert.rejects(env.dispatchQueued(env.context.conv, first), /instantané impossible/);
  assert.equal(env.context.conv.queue.map((entry) => entry.id).join(','), 'a,b');
});

test('un message déjà entré dans le fil ne revient pas dans la file si le spawn échoue', async () => {
  const env = queueHarness();
  const entry = { id: 'a', text: 'à envoyer', images: [] };
  env.context.conv = { id: 'c1', queue: [entry] };
  env.context.dispatch = async (conv, text, images, extra, lifecycle) => {
    lifecycle.onAccepted();
    throw new Error('binaire absent');
  };

  await assert.rejects(env.dispatchQueued(env.context.conv, entry), /binaire absent/);
  assert.equal(env.context.conv.queue.length, 0);
});

test('une préparation interrompue sans erreur conserve aussi le message', async () => {
  const env = queueHarness();
  const entry = { id: 'a', text: 'à envoyer', images: [] };
  env.context.conv = { id: 'c1', queue: [entry] };
  env.context.dispatch = async () => null;

  assert.equal(await env.dispatchQueued(env.context.conv, entry), null);
  assert.equal(env.context.conv.queue.map((queued) => queued.id).join(','), 'a');
});

test('une restauration concurrente ne duplique jamais le message en file', async () => {
  const env = queueHarness();
  const entry = { id: 'a', text: 'à envoyer', images: [] };
  env.context.conv = { id: 'c1', queue: [entry] };
  env.context.dispatch = async () => {
    env.context.conv.queue.push(entry);
    return null;
  };

  assert.equal(await env.dispatchQueued(env.context.conv, entry), null);
  assert.deepEqual(env.context.conv.queue.map((queued) => queued.id), ['a']);
});

test('un échec du premier turn désarme l objectif qui n a jamais démarré', async () => {
  const goals = [];
  const statuses = [];
  const dispatchSource = between(
    'async function dispatch(',
    'const { dispatchQueued } = createQueuedDispatcher'
  );
  const context = {
    running: new Map(),
    store: { get: () => ({ id: 'c1' }) },
    prepareTurn: async (options) => {
      const error = new Error('disque indisponible');
      options.onError(error);
      throw error;
    },
    checkpoints: { snapshot: async () => null },
    setStatus: (id, status) => statuses.push({ id, status }),
    setGoal: (id, goal) => goals.push({ id, goal }),
    broadcast: () => {},
    startTurn: () => {},
    nameConversation: async () => {},
  };
  vm.runInNewContext(`${dispatchSource}\nthis.dispatchUnderTest = dispatch;`, context);

  await assert.rejects(
    context.dispatchUnderTest(
      { id: 'c1', items: [], titleAuto: true },
      'objectif',
      [],
      { goal: 'start' }
    ),
    /disque indisponible/
  );
  assert.deepEqual(goals, [{ id: 'c1', goal: null }]);
  assert.deepEqual(statuses, [{ id: 'c1', status: 'error' }]);
});

function plannedHarness(mode) {
  const conv = {
    id: 'c1', provider: 'claude', providerSessionId: 's1', sessionStarted: true,
    queue: [], cwd: '/tmp', title: 'Parent',
  };
  const queued = [];
  const sent = [];
  const context = {
    store: { get: () => conv },
    running: new Map([[conv.id, { child: { pid: 1 } }]]),
    enqueue: (target, prompt) => queued.push({ id: target.id, prompt }),
    dispatch: async () => assert.fail('un fil occupé ne doit pas lancer un second turn'),
    planned: {
      sent: (id, ranIn) => sent.push({ id, ranIn }),
      failed: () => assert.fail('le message ne doit pas échouer'),
    },
    broadcast: () => {},
    canFork: () => false,
  };
  const sendSource = between('async function sendPlanned(', "app.get('/api/triggers'");
  vm.runInNewContext(`${sendSource}\nthis.sendPlannedUnderTest = sendPlanned;`, context);
  return {
    run: () => context.sendPlannedUnderTest({ id: 'p1', convId: conv.id, prompt: 'pars', mode }),
    queued,
    sent,
  };
}

for (const mode of ['same', 'frozen']) {
  test(`un message planifié ${mode} rejoint la file si son fil travaille`, async () => {
    const env = plannedHarness(mode);
    await env.run();
    assert.deepEqual(env.queued, [{ id: 'c1', prompt: 'pars' }]);
    assert.deepEqual(env.sent, [{ id: 'p1', ranIn: 'c1' }]);
  });
}

test('la note de passation lance explicitement un turn de service', async () => {
  const items = [];
  let turnOptions = null;
  const parent = { id: 'parent', items };
  const context = {
    store: {
      get: () => parent,
      addItem: (id, item) => {
        const saved = { id: `i${items.length + 1}`, ...item };
        items.push(saved);
        return saved;
      },
      touchItem: () => {},
    },
    running: new Map(),
    prepareTurn: async (options) => options.start('checkpoint', {}),
    setStatus: () => {},
    checkpoints: { snapshot: async () => 'checkpoint' },
    handoff: {
      REQUEST: 'Écris la note',
      write: () => '/tmp/handoff.md',
    },
    broadcast: () => {},
    startTurn: (conv, prompt, images, options) => {
      turnOptions = options;
      items.push({ id: 'answer', kind: 'text', text: 'Note structurée' });
      return Promise.resolve({ stopped: false, failed: false });
    },
    path,
  };
  const handoffSource = between('async function writeHandoffNote(', '// Fichiers markdown');
  vm.runInNewContext(`${handoffSource}\nthis.writeHandoffNoteUnderTest = writeHandoffNote;`, context);

  await context.writeHandoffNoteUnderTest(parent);
  assert.equal(turnOptions.isHandoff, true);
});
