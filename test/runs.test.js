'use strict';

// Journal des exécutions de déclencheurs.
//
// Ce que ce journal doit garantir : une exécution laisse une trace même si elle ne revient
// jamais, cette trace survit à la purge de la conversation qui l'a produite, et le fichier
// ne grossit pas indéfiniment.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-runs-'));
process.env.AGENTHUB_DATA = DATA;

const runs = require('../lib/runs');

/** Recharge le module : la seule façon de vérifier ce qui a réellement atterri sur disque. */
let current = runs;
function reload() {
  delete require.cache[require.resolve('../lib/runs')];
  current = require('../lib/runs');
  return current;
}

const lineCount = () =>
  fs.readFileSync(runs.JOURNAL, 'utf8').split('\n').filter((l) => l.trim()).length;

test('une exécution est tracée dès son lancement, avant tout résultat', () => {
  current.start({ convId: 'c1', triggerId: 't1', title: 'nuit', startedAt: '2026-08-01T03:00:00.000Z' });

  const [run] = reload().forTrigger('t1');
  assert.equal(run.convId, 'c1');
  assert.equal(run.status, 'working');
  assert.equal(run.endedAt, null);
});

test('la clôture réécrit la même exécution, elle ne la double pas', () => {
  current.finish('c1', { status: 'done', costUsd: 0.42 });

  const list = reload().forTrigger('t1');
  assert.equal(list.length, 1, 'une exécution reste une ligne à la relecture');
  assert.equal(list[0].status, 'done');
  assert.equal(list[0].costUsd, 0.42);
  assert.ok(list[0].durationMs >= 0);
  assert.ok(lineCount() >= 2, 'le journal est en append-only : les deux écritures sont là');
});

test('clore une exécution inconnue ne crée rien', () => {
  assert.equal(current.finish('jamais-vue', { status: 'done' }), null);
  assert.equal(current.forTrigger('t1').length, 1);
});

test('la plus récente vient en premier, et la limite est respectée', () => {
  for (let i = 2; i <= 5; i += 1) {
    current.start({
      convId: `c${i}`,
      triggerId: 't1',
      startedAt: `2026-08-0${i}T03:00:00.000Z`,
    });
  }

  const list = current.forTrigger('t1');
  assert.equal(list[0].convId, 'c5');
  assert.equal(current.forTrigger('t1', 2).length, 2);
  assert.equal(current.forTrigger('t1', 2)[1].convId, 'c4');
});

test('les exécutions des autres déclencheurs ne se mélangent pas', () => {
  current.start({ convId: 'x1', triggerId: 't2', startedAt: '2026-08-01T04:00:00.000Z' });
  assert.equal(current.forTrigger('t2').length, 1);
  assert.equal(current.forTrigger('t1').length, 5);
});

test('les exécutions restées ouvertes sont récupérables', () => {
  const open = current.open().map((r) => r.convId).sort();
  assert.deepEqual(open, ['c2', 'c3', 'c4', 'c5', 'x1'], 'c1 est close, les autres non');

  for (const run of current.open()) current.finish(run.convId, { status: 'error', error: 'coupé' });
  assert.equal(current.open().length, 0);
  assert.equal(reload().forTrigger('t1')[0].error, 'coupé');
});

test('supprimer un déclencheur oublie ses exécutions, pas celles des autres', () => {
  assert.equal(current.forget('t1'), 5);
  assert.equal(current.forTrigger('t1').length, 0);
  assert.equal(current.forTrigger('t2').length, 1);
  // La compaction a réécrit le fichier : ce qui est oublié l'est aussi sur disque.
  assert.equal(reload().forTrigger('t1').length, 0);
});

test('une exécution réécrite sans fin ne fait pas enfler le journal', () => {
  // Le cas qui fait grossir le fichier : une même exécution reclose à chaque turn, parce
  // qu'elle enchaîne sur des messages en attente.
  current.start({ convId: 'bavarde', triggerId: 't3', startedAt: '2026-08-01T05:00:00.000Z' });
  for (let i = 0; i < 200; i += 1) current.finish('bavarde', { status: 'done', costUsd: 0.01 });

  assert.ok(lineCount() < 100, `${lineCount()} lignes pour une seule exécution`);
  assert.equal(current.forTrigger('t3').length, 1);
  assert.equal(reload().forTrigger('t3')[0].costUsd, 0.01);
});

test("au-delà du plafond, ce sont les plus anciennes qui partent", () => {
  const extra = runs.MAX_PER_TRIGGER + 20;
  for (let i = 0; i < extra; i += 1) {
    // Horodatage croissant sur deux champs : l'ordre doit rester lisible au-delà de 99.
    const stamp = `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
    current.start({ convId: `p${i}`, triggerId: 't4', startedAt: stamp });
    current.finish(`p${i}`, { status: 'done' });
  }

  const kept = reload().forTrigger('t4');
  assert.ok(kept.length <= runs.MAX_PER_TRIGGER, `${kept.length} gardées, plafond ${runs.MAX_PER_TRIGGER}`);
  assert.equal(kept[0].convId, `p${extra - 1}`, 'la plus récente est toujours là');
  assert.ok(
    !kept.some((r) => r.convId === 'p0'),
    'la plus ancienne a bien été oubliée'
  );
});
