'use strict';

const test = require('node:test');
const assert = require('node:assert');

const silence = require('../lib/silence');

const MINUTE = 60_000;
const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('un turn qui vient d ecrire n est pas silencieux', () => {
  const records = [{ convId: 'c1', startedAt: ago(60 * MINUTE), lastAt: ago(30_000) }];
  assert.deepEqual(silence.scan(records, NOW), []);
});

test('un turn muet depuis le seuil est signale', () => {
  const records = [{ convId: 'c1', startedAt: ago(60 * MINUTE), lastAt: ago(12 * MINUTE) }];
  const found = silence.scan(records, NOW);
  assert.equal(found.length, 1);
  assert.equal(found[0].convId, 'c1');
  assert.equal(found[0].idleMs, 12 * MINUTE);
});

// Le point de la fonctionnalité : c'est le dernier écrit qui compte, pas le lancement. Un
// turn lancé il y a trois heures et qui écrit sans arrêt n'a rien d'anormal.
test('c est le dernier ecrit qui compte, pas le lancement', () => {
  const records = [{ convId: 'c1', startedAt: ago(180 * MINUTE), lastAt: ago(MINUTE) }];
  assert.deepEqual(silence.scan(records, NOW), []);
});

// Les enregistrements ouverts avant l'ajout du champ n'ont pas de `lastAt` : on se rabat sur
// le lancement, ce qui peut signaler un turn bavard. Un signal de trop vaut mieux qu'un
// silence manqué, et le cas disparaît au premier turn suivant.
test('sans lastAt, le lancement fait foi', () => {
  const records = [{ convId: 'c1', startedAt: ago(40 * MINUTE) }];
  assert.equal(silence.scan(records, NOW)[0].idleMs, 40 * MINUTE);
});

test('une date illisible ne signale rien', () => {
  assert.deepEqual(silence.scan([{ convId: 'c1', lastAt: 'jamais' }], NOW), []);
});

test('le plus muet passe en premier', () => {
  const records = [
    { convId: 'court', lastAt: ago(11 * MINUTE) },
    { convId: 'long', lastAt: ago(90 * MINUTE) },
  ];
  assert.deepEqual(
    silence.scan(records, NOW).map((r) => r.convId),
    ['long', 'court']
  );
});

// Le silence grandit à chaque tick. Rediffuser une liste identique à un chiffre près ferait
// repeindre la barre latérale toutes les trente secondes pour rien.
test('un silence qui grandit ne vaut pas une diffusion', () => {
  const before = [{ convId: 'c1', idleMs: 11 * MINUTE }];
  const after = [{ convId: 'c1', idleMs: 12 * MINUTE }];
  assert.equal(silence.changed(before, after), false);
  assert.equal(silence.changed(before, []), true);
  assert.equal(silence.changed(before, [...after, { convId: 'c2', idleMs: MINUTE }]), true);
});

test('l ordre ne fait pas une diffusion', () => {
  const a = [{ convId: 'x' }, { convId: 'y' }];
  const b = [{ convId: 'y' }, { convId: 'x' }];
  assert.equal(silence.changed(a, b), false);
});

test('le libelle passe aux heures', () => {
  assert.equal(silence.label(12 * MINUTE), 'silencieux depuis 12 min');
  assert.equal(silence.label(60 * MINUTE), 'silencieux depuis 1 h');
  assert.equal(silence.label(95 * MINUTE), 'silencieux depuis 1 h 35');
});
