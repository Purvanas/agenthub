'use strict';

const test = require('node:test');
const assert = require('node:assert');

const view = require('../lib/conversation-view');

const rows = (count) =>
  Array.from({ length: count }, (_, index) => ({ id: `i${index}`, kind: 'text', text: `${index}` }));

test('la première ouverture ne renvoie que la fin du fil', () => {
  const found = view.pageItems(rows(250), { limit: 100 });
  assert.equal(found.items.length, 100);
  assert.equal(found.items[0].id, 'i150');
  assert.equal(found.items.at(-1).id, 'i249');
  assert.deepEqual(found.page, {
    total: 250,
    hasMore: true,
    before: 'i150',
    hasNewer: false,
    after: 'i249',
  });
});

test('before charge la page précédente sans répéter son ancre', () => {
  const found = view.pageItems(rows(250), { limit: 100, before: 'i150' });
  assert.equal(found.items[0].id, 'i50');
  assert.equal(found.items.at(-1).id, 'i149');
  assert.equal(found.page.hasMore, true);
  assert.equal(found.page.hasNewer, true);
});

test('focus renvoie une fenêtre bornée qui contient le message cherché', () => {
  const found = view.pageItems(rows(250), { limit: 40, focus: 'i80' });
  assert.equal(found.items.length, 40);
  assert.equal(found.items.some((item) => item.id === 'i80'), true);
  assert.equal(found.page.hasMore, true);
  assert.equal(found.page.hasNewer, true);
});

test('after permet de revenir vers les messages récents', () => {
  const found = view.pageItems(rows(250), { limit: 20, after: 'i99' });
  assert.equal(found.items[0].id, 'i100');
  assert.equal(found.items.at(-1).id, 'i119');
});

test("une ancre inconnue retombe sur la fin du fil", () => {
  const found = view.pageItems(rows(12), { limit: 5, before: 'absent' });
  assert.deepEqual(found.items.map((item) => item.id), ['i7', 'i8', 'i9', 'i10', 'i11']);
});

test("une grosse sortie d'outil est projetée sans modifier l'original", () => {
  const item = { id: 'tool', kind: 'tool', result: 'x'.repeat(view.RESULT_PREVIEW + 17) };
  const projected = view.projectItem(item);
  assert.equal(projected.result.length, view.RESULT_PREVIEW);
  assert.equal(projected.resultTruncated, true);
  assert.equal(projected.resultLength, view.RESULT_PREVIEW + 17);
  assert.equal(item.result.length, view.RESULT_PREVIEW + 17);
  assert.equal(item.resultTruncated, undefined);
});

test('le résultat intégral reste disponible par identifiant', () => {
  const item = { id: 'tool', kind: 'tool', result: 'sortie complète' };
  assert.deepEqual(view.fullResult([item], 'tool'), { found: true, result: 'sortie complète' });
  assert.deepEqual(view.fullResult([item], 'absent'), { found: false, result: null });
});
