'use strict';

const test = require('node:test');
const assert = require('node:assert');

const presence = require('../lib/presence');

test.beforeEach(() => presence.clear());

test('un client qui regarde la conversation compte', () => {
  presence.join('a');
  presence.update('a', { convId: 'c1', visible: true });
  assert.equal(presence.watching('c1'), true);
  // Une autre conversation : personne ne verra la question, il faut sonner.
  assert.equal(presence.watching('c2'), false);
});

test('un onglet en arriere-plan ne regarde pas', () => {
  presence.join('a');
  presence.update('a', { convId: 'c1', visible: false });
  assert.equal(presence.watching('c1'), false);
});

test('deux appareils : il suffit que l un regarde', () => {
  presence.join('pc');
  presence.join('tel');
  presence.update('pc', { convId: 'c1', visible: false });
  presence.update('tel', { convId: 'c1', visible: true });
  assert.equal(presence.watching('c1'), true);
});

test('le telephone sur un autre fil ne compte pas pour celui-ci', () => {
  // C'est le cas que la fonctionnalité vise : présent, mais ailleurs.
  presence.join('tel');
  presence.update('tel', { convId: 'c2', visible: true });
  assert.equal(presence.watching('c1'), false);
  assert.equal(presence.watching('c2'), true);
});

test('un client parti ne regarde plus', () => {
  presence.join('a');
  presence.update('a', { convId: 'c1', visible: true });
  presence.leave('a');
  assert.equal(presence.watching('c1'), false);
});

test('un client muet trop longtemps est considere absent', () => {
  presence.join('a');
  presence.update('a', { convId: 'c1', visible: true });
  // Un téléphone mis en veille laisse sa socket ouverte : sans péremption, il passerait
  // pour présent et la notification ne partirait jamais.
  const later = Date.now() + presence.STALE_MS + 1;
  assert.equal(presence.watching('c1', later), false);
  assert.deepEqual(presence.snapshot(later), []);
});

test('une annonce apres le depart ne ressuscite pas la presence', () => {
  presence.join('a');
  presence.leave('a');
  assert.equal(presence.update('a', { convId: 'c1', visible: true }), null);
  assert.equal(presence.watching('c1'), false);
});

test('sans conversation ouverte, on ne regarde rien', () => {
  presence.join('a');
  presence.update('a', { convId: null, visible: true });
  assert.equal(presence.watching('c1'), false);
  assert.equal(presence.watching(null), false);
});
