'use strict';

// La boucle repose sur setInterval, qui ne connaît pas les promesses. Les ticks restent
// volontairement concurrents pour qu'un instantané lent ne bloque pas toutes les échéances ;
// ce test protège la prise unitaire qui empêche deux ticks d'envoyer le même message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-scheduler-'));
process.env.AGENTHUB_DATA = DATA;
process.env.AGENTHUB_TICK_MS = '5';

const planned = require('../lib/planned');
const scheduler = require('../lib/scheduler');

test('deux ticks ne traitent pas le même message planifié en parallèle', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  fs.writeFileSync(
    planned.FILE,
    JSON.stringify([
      {
        id,
        convId: 'c1',
        prompt: 'pars maintenant',
        runAt: new Date(Date.now() - 1000).toISOString(),
        mode: 'same',
        status: 'pending',
        createdAt: new Date().toISOString(),
        sentAt: null,
        ranIn: null,
        error: null,
      },
    ])
  );

  let release;
  const held = new Promise((resolve) => (release = resolve));
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const firstTick = scheduler.start({
    snapshot: () => ({ triggers: [], conversations: [{ id: 'c1' }], hasChildren: () => false }),
    save: () => {},
    launch: async () => {},
    purgeRun: async () => {},
    sendPlanned: async (message) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await held;
      planned.sent(message.id, message.convId);
      active -= 1;
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls, 1, 'les ticks suivants ignorent le travail encore en cours');
  assert.equal(maxActive, 1);
  release();
  await firstTick;
  scheduler.stop();
});

test.after(() => {
  scheduler.stop();
  fs.rmSync(DATA, { recursive: true, force: true });
});
