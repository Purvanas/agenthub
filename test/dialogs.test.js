'use strict';

// File des actions différées, celle qui remplace « Supprimer ? OK / Annuler ».
//
// L'écran ment par avance : la ligne disparaît avant que le serveur soit prévenu. Tout
// repose donc sur cette file, et deux fautes y seraient invisibles à l'œil — une action
// annulée qui part quand même, et une action validée qu'on perd en fermant l'onglet. Ni
// l'une ni l'autre ne se voit au moment où elle arrive.

const test = require('node:test');
const assert = require('node:assert');

const { createUndoQueue } = require('../public/dialogs');

/** Minuteurs de papier : le temps n'avance que quand on le décide. */
function fakeClock() {
  const timers = new Map();
  let seq = 0;
  return {
    setTimer(fn) {
      timers.set(++seq, fn);
      return seq;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    tick() {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, fn] of due) fn();
    },
    pending: () => timers.size,
  };
}

function queueWith(extra) {
  const clock = fakeClock();
  const done = [];
  const queue = createUndoQueue({
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...extra,
  });
  return { clock, done, queue };
}

test("l'action ne part pas tout de suite, mais au bout du délai", () => {
  const { clock, done, queue } = queueWith();
  queue.push(() => done.push('supprimé'));

  assert.deepEqual(done, []); // rien n'est encore parti au serveur
  assert.equal(queue.size(), 1);

  clock.tick();
  assert.deepEqual(done, ['supprimé']);
  assert.equal(queue.size(), 0);
});

test('le délai suit celui de la barre affichée, pas celui de la file', () => {
  const asked = [];
  const clock = fakeClock();
  const queue = createUndoQueue({
    delay: 6000,
    setTimer: (fn, ms) => (asked.push(ms), clock.setTimer(fn)),
    clearTimer: clock.clearTimer,
  });

  queue.push(() => {}, null, 2500);
  queue.push(() => {});

  // Sinon l'avis annonce un décompte de 2,5 s et l'action part six secondes plus tard :
  // « Annuler » resterait cliquable alors que la barre est arrivée au bout.
  assert.deepEqual(asked, [2500, 6000]);
});

test('annuler empêche définitivement le départ', () => {
  const { clock, done, queue } = queueWith();
  const id = queue.push(() => done.push('supprimé'));

  assert.equal(queue.cancel(id), true);
  assert.equal(clock.pending(), 0); // le minuteur est retiré, pas juste ignoré

  clock.tick();
  assert.deepEqual(done, []);
});

test('annuler une action déjà partie renvoie false, sans la rejouer', () => {
  const { clock, done, queue } = queueWith();
  const id = queue.push(() => done.push('supprimé'));
  clock.tick();

  assert.equal(queue.cancel(id), false);
  assert.deepEqual(done, ['supprimé']); // et pas deux fois
});

test('fermer la page fait partir ce qui attendait', () => {
  const { done, queue } = queueWith();
  queue.push(() => done.push('a'));
  queue.push(() => done.push('b'));

  queue.flush();

  // Sans ça, l'utilisateur a lu « supprimé », est parti, et rien n'avait été supprimé.
  assert.deepEqual(done, ['a', 'b']);
  assert.equal(queue.size(), 0);
});

test('un vidage après annulation ne ressuscite pas ce qui a été annulé', () => {
  const { done, queue } = queueWith();
  const gardé = queue.push(() => done.push('gardé'));
  queue.push(() => done.push('parti'));

  queue.cancel(gardé);
  queue.flush();

  assert.deepEqual(done, ['parti']);
});

test('plusieurs suppressions de suite s’annulent chacune de son côté', () => {
  const { clock, done, queue } = queueWith();
  const a = queue.push(() => done.push('a'));
  queue.push(() => done.push('b'));
  const c = queue.push(() => done.push('c'));

  queue.cancel(a);
  queue.cancel(c);
  clock.tick();

  assert.deepEqual(done, ['b']);
});

test('une action qui échoue est signalée, sans emporter la file', () => {
  const seen = [];
  const { clock, done, queue } = queueWith({ onError: (err) => seen.push(err.message) });

  queue.push(() => {
    throw new Error('HTTP 500');
  });
  queue.push(() => done.push('la suivante passe quand même'));
  clock.tick();

  assert.deepEqual(seen, ['HTTP 500']);
  assert.deepEqual(done, ['la suivante passe quand même']);
});

test('un rejet asynchrone est signalé lui aussi', async () => {
  const seen = [];
  const { clock, queue } = queueWith({ onError: (err) => seen.push(err.message) });

  // Le cas courant : `run` est un `async` qui appelle l'API. Sans le rattraper ici,
  // l'échec ne serait visible nulle part — la ligne a déjà disparu de l'écran.
  queue.push(async () => {
    throw new Error('conversation introuvable');
  });
  clock.tick();
  await Promise.resolve();

  assert.deepEqual(seen, ['conversation introuvable']);
});

test('ce qu’on avait fait disparaître est rendu à qui doit le remettre', () => {
  const seen = [];
  const { clock, queue } = queueWith({ onError: (err, entry) => seen.push(entry.meta.hide) });

  queue.push(
    () => {
      throw new Error('non');
    },
    { hide: 'la ligne' }
  );
  clock.tick();

  assert.deepEqual(seen, ['la ligne']);
});
