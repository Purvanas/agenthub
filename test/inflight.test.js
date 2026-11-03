'use strict';

// Registre des turns en vol : ce qui permet de reprendre un turn après un redémarrage.
//
// Le champ qui compte est `offset` : la position jusqu'à laquelle le flux a été **traité**.
// S'il avance trop, des événements sont perdus ; pas assez, ils sont rejoués. Les deux se
// voient dans le fil de la conversation.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-inflight-'));
process.env.AGENTHUB_DATA = DATA;

const inflight = require('../lib/inflight');

const CONV = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

test('un turn ouvert est retrouvable, avec ses fichiers de flux', () => {
  const modelSelection = {
    model: 'opus',
    launchedModel: 'opus',
    effort: 'high',
    launchedEffort: 'high',
    mode: 'pinned',
    source: 'user',
    startedAt: new Date().toISOString(),
  };
  const rec = inflight.open({
    convId: CONV,
    pid: 4242,
    provider: 'claude',
    modelSelection,
  });
  assert.equal(rec.offset, 0);
  assert.equal(rec.pid, 4242);
  assert.ok(rec.out.endsWith(`${CONV}.jsonl`));
  assert.deepEqual(rec.modelSelection, modelSelection);

  const found = inflight.list();
  assert.equal(found.length, 1);
  assert.equal(found[0].convId, CONV);
});

test('la position n’est réécrite que si elle a bougé', () => {
  assert.ok(inflight.advance(CONV, 128));
  assert.equal(inflight.advance(CONV, 128), null, 'même position : pas d’écriture');
  assert.equal(inflight.list()[0].offset, 128);
  assert.equal(inflight.advance('inconnue', 10), null);
});

test('la position survit à un rechargement du module', () => {
  // C'est tout l'intérêt : après un redémarrage, on doit repartir d'où on en était.
  delete require.cache[require.resolve('../lib/inflight')];
  const relu = require('../lib/inflight');
  assert.equal(relu.list()[0].offset, 128);
  assert.equal(relu.list()[0].modelSelection.launchedModel, 'opus');
});

test('fermer un turn efface son enregistrement et ses fichiers', () => {
  fs.writeFileSync(inflight.outPath(CONV), '{"type":"x"}\n');
  fs.writeFileSync(inflight.errPath(CONV), 'du bruit');

  inflight.close(CONV);
  assert.deepEqual(inflight.list(), []);
  assert.equal(fs.existsSync(inflight.outPath(CONV)), false);
  assert.equal(fs.existsSync(inflight.errPath(CONV)), false);
});

test('fermer un turn inconnu ne casse rien', () => {
  inflight.close('jamais-ouverte');
  assert.deepEqual(inflight.list(), []);
});

test('le processus courant est vu comme vivant, un pid absurde comme mort', () => {
  assert.equal(inflight.alive(process.pid), true);
  assert.equal(inflight.alive(0), false);
  assert.equal(inflight.alive(null), false);
  // 2^22 dépasse le pid_max usuel : personne ne tourne là.
  assert.equal(inflight.alive(4194303), false);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
