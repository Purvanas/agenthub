'use strict';

// Mode objectif.
//
// Ce que ces tests protègent : une boucle qui ne s'arrête pas ne se voit pas en relisant le
// code, elle se voit en la faisant tourner. Chaque tour dépense deux turns d'agent — donc du
// quota, éventuellement la nuit — et les trois façons de sortir (atteint, plafond, échec)
// doivent être atteignables depuis n'importe quel état.

const test = require('node:test');
const assert = require('node:assert');

const goal = require('../lib/goal');

test('un objectif démarre à son premier tour', () => {
  const g = goal.start('  Passer tous les tests  ', 12);
  assert.equal(g.text, 'Passer tous les tests');
  assert.equal(g.round, 1);
  assert.equal(g.max, 12);
});

test('un plafond fantaisiste retombe sur le défaut', () => {
  // Le plafond vient du navigateur : il ne décide pas seul de combien de turns on dépense.
  assert.equal(goal.start('x', 9999).max, goal.DEFAULT_ROUNDS);
  assert.equal(goal.start('x', 0).max, goal.DEFAULT_ROUNDS);
  assert.equal(goal.start('x').max, goal.DEFAULT_ROUNDS);
  assert.equal(goal.start('x', '25').max, 25);
});

test('sans objectif, la boucle ne se mêle de rien', () => {
  assert.equal(goal.decide(null, 'done'), null);
  assert.equal(goal.decide({ text: '' }, 'done'), null);
});

test('un turn de travail fini demande la vérification', () => {
  const g = goal.start('x', 6);
  assert.deepEqual(goal.decide(g, 'done'), { action: 'check' });
});

test('objectif atteint : la boucle s’arrête', () => {
  const g = goal.start('x', 6);
  const done = goal.decide(g, 'done', { done: true, remaining: '', summary: 'fini' });
  assert.equal(done.action, 'reached');
});

test('objectif non atteint : un tour de plus, numéroté', () => {
  const g = goal.start('x', 6);
  const next = goal.decide(g, 'done', { done: false, remaining: 'il reste ceci' });
  assert.deepEqual(next, { action: 'continue', round: 2 });
});

test('au plafond, la boucle rend la main au lieu de relancer', () => {
  const g = { ...goal.start('x', 3), round: 3 };
  assert.equal(goal.decide(g, 'done', { done: false, remaining: 'encore' }).action, 'exhausted');
});

test('un échec ou une interruption arrête la boucle', () => {
  // Sans ça, une erreur d'authentification consomme les relances une par une sans avancer.
  const g = goal.start('x', 25);
  assert.equal(goal.decide(g, 'error').action, 'abandon');
  assert.equal(goal.decide(g, 'stopped').action, 'abandon');
});

test('une vérification illisible arrête la boucle', () => {
  const g = goal.start('x', 6);
  assert.equal(goal.decide(g, 'done', null).action, 'abandon');
});

test('la vérification est refusée si elle ne dit pas ce qui manque', () => {
  // « pas fini » sans rien d'autre relancerait un tour sans consigne.
  assert.equal(goal.normalize({ done: false, remaining: '  ', summary: 'en cours' }), null);
  assert.equal(goal.normalize({ done: true, remaining: '', summary: 'fini' }).done, true);
  assert.equal(goal.normalize({ remaining: 'x', summary: 'y' }), null);
  assert.equal(goal.normalize(null), null);
});

test('le premier prompt interdit de rendre la main pour demander un avis', () => {
  const prompt = goal.buildFirstPrompt('Passer tous les tests');
  assert.ok(prompt.includes('Passer tous les tests'));
  assert.ok(/ne demande pas de validation/i.test(prompt), prompt);
});

test('le prompt de vérification interdit de travailler', () => {
  // Sinon l'agent finit le travail pendant la vérification, qui ne vérifie alors plus rien.
  const prompt = goal.buildCheckPrompt('Passer tous les tests');
  assert.ok(/ne modifie rien/i.test(prompt), prompt);
  assert.ok(/sans rien modifier/i.test(prompt), prompt);
});

test('la relance porte ce qui reste, et dit où on en est', () => {
  const g = { ...goal.start('Passer tous les tests', 6), round: 3 };
  const prompt = goal.buildContinuePrompt(g, { done: false, remaining: 'le test de tri échoue' });
  assert.ok(prompt.includes('le test de tri échoue'));
  assert.ok(prompt.includes('tour 3 sur 6'));
});
