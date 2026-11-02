'use strict';

// Puces du composeur.
//
// Ce que ces tests protègent : du code qui déplace un curseur dans une chaîne ne se plante
// pas, il se trompe — le champ ne lève rien, il place juste le texte au mauvais endroit. Et
// une conversion trop gourmande enverrait « • » à l'agent, ou prendrait un tiret au milieu
// d'une phrase pour un début de liste.

const test = require('node:test');
const assert = require('node:assert');

const bullets = require('../public/bullets');

/** Ce que le champ afficherait après la décision : plus lisible qu'un triplet de positions. */
function after(value, edit) {
  return bullets.apply(value, edit);
}

test('un tiret puis une espace, en début de ligne, devient une puce', () => {
  const out = after('-', bullets.onSpace('-', 1));
  assert.equal(out.value, '• ');
  assert.equal(out.caret, 2);
});

test("l'indentation d'une liste imbriquée est gardée", () => {
  const written = '• premier\n  -';
  const out = after(written, bullets.onSpace(written, written.length));
  assert.equal(out.value, '• premier\n  • ');
  assert.equal(out.caret, 14);
});

test('un tiret au milieu d’une phrase ne devient pas une puce', () => {
  assert.equal(bullets.onSpace('3 -', 3), null);
  assert.equal(bullets.onSpace('deux-', 5), null);
});

test('le saut de ligne dans une puce en ouvre une autre', () => {
  const out = after('• premier', bullets.onNewline('• premier', 9));
  assert.equal(out.value, '• premier\n• ');
  assert.equal(out.caret, 12);
});

test('le saut de ligne sur une puce vide sort de la liste', () => {
  // Sans ça, finir une liste demande d'effacer à la main la puce qu'on vient de recevoir.
  const written = '• premier\n• ';
  const out = after(written, bullets.onNewline(written, written.length));
  assert.equal(out.value, '• premier\n\n');
  assert.equal(out.caret, 11);
});

test('hors liste, le saut de ligne ne concerne pas ce module', () => {
  assert.equal(bullets.onNewline('une phrase', 10), null);
});

test('le retour arrière enlève la puce entière', () => {
  const written = '• premier\n• ';
  const out = after(written, bullets.onBackspace(written, written.length));
  assert.equal(out.value, '• premier\n');
  assert.equal(out.caret, 10);
  // Ailleurs qu'immédiatement derrière une puce, il ne se passe rien de spécial.
  assert.equal(bullets.onBackspace('• premier', 9), null);
});

test('un remplacement ne touche que sa plage', () => {
  // Ce que l'appelant donne à la saisie du navigateur : de tel caractère à tel autre.
  const edit = bullets.onSpace('déjà écrit\n-', 12);
  assert.deepEqual(edit, { from: 11, to: 12, text: '• ' });
});

test("ce qui part à l'agent est du markdown, indentation comprise", () => {
  const written = '• premier\n  • imbriqué\nune phrase • pas une puce';
  assert.equal(
    bullets.toMarkdown(written),
    '- premier\n  - imbriqué\nune phrase • pas une puce'
  );
});

test('un texte sans puce traverse la conversion inchangé', () => {
  const written = '- déjà en markdown\ntexte';
  assert.equal(bullets.toMarkdown(written), written);
  assert.equal(bullets.toMarkdown(''), '');
  assert.equal(bullets.toMarkdown(null), '');
});
