'use strict';

// Mémoire d'un projet : les leçons d'hier rendues à l'agent d'aujourd'hui.
//
// Deux choses sont testées ici parce qu'elles décident du reste : quand on accepte de dépenser
// un turn pour tirer une leçon, et le fait qu'une leçon proposée n'entre pas dans les prompts
// avant d'avoir été relue.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-memory-'));
process.env.AGENTHUB_DATA = DATA;

const memory = require('../lib/memory');

const PROJECT = '/srv/projects/demo-app';
const OK = { outcome: 'done', project: PROJECT, items: [{ isError: true }], pending: false };

test.beforeEach(() => fs.rmSync(memory.FILE, { force: true }));

// --- Quand dépenser un turn ------------------------------------------------

test('un turn qui s est cogne et s en est sorti merite la question', () => {
  assert.equal(memory.worthAsking(OK), true);
});

test('un turn sans mur n a rien appris, juste travaille', () => {
  assert.equal(memory.worthAsking({ ...OK, items: [{ kind: 'text' }] }), false);
  assert.equal(memory.worthAsking({ ...OK, items: [] }), false);
});

test('un turn en echec n a rien resolu', () => {
  assert.equal(memory.worthAsking({ ...OK, outcome: 'error' }), false);
  assert.equal(memory.worthAsking({ ...OK, outcome: 'stopped' }), false);
});

test('sans projet, la lecon ne serait rendue a personne', () => {
  assert.equal(memory.worthAsking({ ...OK, project: '' }), false);
});

// Sans cette condition, un fil bavard proposerait une fiche par turn, et on n'en relirait
// aucune.
test('une fiche deja en attente sur la conversation suffit', () => {
  assert.equal(memory.worthAsking({ ...OK, pending: true }), false);
});

// --- Proposé n'est pas gardé -----------------------------------------------

test('une fiche proposee n entre pas dans le prompt', () => {
  memory.propose({ project: PROJECT, convId: 'c1', title: 'Piège', lesson: 'Ne fais pas ça.' });
  assert.equal(memory.promptBlock(PROJECT), '');
});

test('une fiche gardee entre dans le prompt, une ecartee non', () => {
  const a = memory.propose({ project: PROJECT, convId: 'c1', title: 'Gardée', lesson: 'A.' });
  const b = memory.propose({ project: PROJECT, convId: 'c2', title: 'Écartée', lesson: 'B.' });
  memory.decide(a.id, 'kept');
  memory.decide(b.id, 'dismissed');

  const block = memory.promptBlock(PROJECT);
  assert.match(block, /Gardée — A\./);
  assert.equal(block.includes('Écartée'), false);
  // Le ton : un agent en autonomie totale ne doit pas prendre cette liste pour des tâches.
  assert.match(block, /il n'y a rien a corriger/);
});

test('la memoire d un projet ne fuit pas dans un autre', () => {
  const a = memory.propose({ project: PROJECT, convId: 'c1', title: 'Ici', lesson: 'A.' });
  memory.decide(a.id, 'kept');
  assert.equal(memory.promptBlock('/var/www/site'), '');
});

test('une lecon multiligne est repliee sur une ligne du prompt', () => {
  const a = memory.propose({
    project: PROJECT,
    convId: 'c1',
    title: 'T',
    lesson: 'Première ligne.\n\nSeconde ligne.',
  });
  memory.decide(a.id, 'kept');
  const lesson = memory.promptBlock(PROJECT).split('\n').find((l) => l.startsWith('- T'));
  assert.equal(lesson, '- T — Première ligne. Seconde ligne.');
});

test('le prompt est borne', () => {
  for (let i = 0; i < memory.MAX_IN_PROMPT + 5; i += 1) {
    const row = memory.propose({ project: PROJECT, convId: `c${i}`, title: `T${i}`, lesson: 'x' });
    memory.decide(row.id, 'kept');
  }
  const lines = memory.promptBlock(PROJECT).split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, memory.MAX_IN_PROMPT);
});

// --- Cycle de vie ----------------------------------------------------------

test('une fiche sans titre ou sans lecon est refusee', () => {
  assert.throws(() => memory.propose({ project: PROJECT, title: '', lesson: 'x' }), /Titre vide/);
  assert.throws(() => memory.propose({ project: PROJECT, title: 'x', lesson: ' ' }), /Leçon vide/);
});

test('un etat inconnu est refuse', () => {
  const row = memory.propose({ project: PROJECT, convId: 'c1', title: 'T', lesson: 'L' });
  assert.throws(() => memory.decide(row.id, 'peut-etre'), /État inconnu/);
});

test('trancher accepte un texte corrige', () => {
  const row = memory.propose({ project: PROJECT, convId: 'c1', title: 'Brouillon', lesson: 'L' });
  const kept = memory.decide(row.id, 'kept', { title: 'Titre relu', lesson: 'Leçon relue.' });
  assert.equal(kept.title, 'Titre relu');
  assert.match(memory.promptBlock(PROJECT), /Titre relu — Leçon relue\./);
});

// Une fiche gardée appartient au projet, pas au fil : supprimer la conversation ne doit pas
// emporter ce qu'on avait décidé de retenir.
test('supprimer une conversation n emporte que ses fiches en attente', () => {
  const attente = memory.propose({ project: PROJECT, convId: 'c1', title: 'A', lesson: 'x' });
  const gardee = memory.propose({ project: PROJECT, convId: 'c1', title: 'B', lesson: 'y' });
  memory.decide(gardee.id, 'kept');

  assert.equal(memory.forget('c1'), 1);
  assert.equal(memory.get(attente.id), null);
  assert.equal(memory.get(gardee.id).title, 'B');
});

test('le nom de fichier d une fiche se lit', () => {
  assert.equal(memory.slug('Le dépôt fantôme archivait data/'), 'le-depot-fantome-archivait-data');
  assert.equal(memory.slug('!!!'), 'lecon');
});

test('la fiche markdown porte son titre en tete', () => {
  assert.equal(memory.markdown({ title: 'T', lesson: 'L.' }), '# T\n\nL.\n');
});
