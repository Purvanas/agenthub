'use strict';

const test = require('node:test');
const assert = require('node:assert');

const ideas = require('../public/ideas');

test('une ligne marquee se decoupe en titre et description', () => {
  assert.deepEqual(ideas.match('[idée] Le match — rejouer un message sur deux agents'), {
    title: 'Le match',
    body: 'rejouer un message sur deux agents',
  });
});

test('sans separateur, tout est titre', () => {
  // Une idée en trois mots n'a pas de description : en inventer une vide gênerait plus
  // qu'elle n'aiderait.
  assert.deepEqual(ideas.match('[idée] Plafond de dépense'), {
    title: 'Plafond de dépense',
    body: '',
  });
});

test('le marqueur est tolere derriere une puce, sans accent et en majuscules', () => {
  // Un agent qui énumère écrit naturellement « - [idée] … », et tape « idee » une fois sur
  // deux : refuser ces formes rendrait la fonctionnalité aléatoire.
  for (const line of [
    '- [idée] Titre — corps',
    '* [idee] Titre — corps',
    '  + [IDÉE] Titre — corps',
    '[Idee]  Titre — corps',
  ]) {
    assert.deepEqual(ideas.match(line), { title: 'Titre', body: 'corps' }, line);
  }
});

test('le tiret demi-cadratin separe aussi', () => {
  assert.deepEqual(ideas.match('[idée] Titre – corps'), { title: 'Titre', body: 'corps' });
});

test('une ligne ordinaire n est jamais une idee', () => {
  // Le risque à éviter : flaguer une liste de fichiers ou les étapes d'un plan. Un bouton
  // « ajouter à la todo » sous une phrase qui n'est pas une proposition discrédite les vrais.
  for (const line of [
    'Voici trois idées pour la suite :',
    '- Le match : rejouer un message sur deux agents',
    "j'ai une idée [pas marquée]",
    '',
    '   ',
  ]) {
    assert.equal(ideas.match(line), null, line);
  }
});

test('un marqueur sans texte ne fait pas de carte vide', () => {
  assert.equal(ideas.match('[idée]'), null);
  assert.equal(ideas.match('- [idée]    '), null);
});

test('le marqueur doit ouvrir la ligne', () => {
  // Sinon une phrase qui cite le marqueur en produirait une carte.
  assert.equal(ideas.match('On pourrait écrire [idée] Titre — corps'), null);
});

test('les idees d un texte sortent dans l ordre, sans le reste', () => {
  const text = [
    'Voici ce que je propose :',
    '',
    '- [idée] Le match — rejouer un message sur deux agents',
    '- [idée] Relecture croisée — un autre fournisseur relit le diff',
    '',
    "Dis-moi lequel t'intéresse.",
  ].join('\n');
  assert.deepEqual(ideas.all(text).map((i) => i.title), ['Le match', 'Relecture croisée']);
  assert.equal(ideas.all('rien de marqué ici').length, 0);
});

test('titre et corps sont bornes', () => {
  const long = 'x'.repeat(600);
  const found = ideas.match(`[idée] ${long} — ${'y'.repeat(6000)}`);
  assert.equal(found.title.length, ideas.MAX_TITLE);
  assert.equal(found.body.length, ideas.MAX_BODY);
});
