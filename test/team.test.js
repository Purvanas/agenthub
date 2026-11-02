'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-team-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/team')];
  return require('../lib/team');
}

const TICKET = { id: 't1', title: 'Refondre le hero', body: 'Trop chargé.' };

test('le relecteur vient toujours d’un autre fournisseur', () => {
  const team = fresh();
  // C'est tout l'intérêt : un modèle qui relit son propre travail valide ses angles morts.
  assert.notEqual(team.reviewerFor('claude'), 'claude');
  assert.notEqual(team.reviewerFor('codex'), 'codex');
  assert.notEqual(team.reviewerFor('grok'), 'grok');
});

test('le relecteur se rabat sur ce qui est disponible', () => {
  const team = fresh();
  assert.equal(team.reviewerFor('claude', ['grok']), 'grok');
  // Aucun autre : relire avec le même vaut mieux que sauter l'étape.
  assert.equal(team.reviewerFor('claude', ['claude']), 'claude');
});

test('la chaîne va du plan à la relecture puis s’arrête', () => {
  const team = fresh();
  assert.deepEqual(team.next('plan', 'done'), { action: 'next', stage: 'build' });
  assert.deepEqual(team.next('build', 'done'), { action: 'next', stage: 'review' });
  assert.deepEqual(team.next('review', 'done'), { action: 'finish' });
});

test('un échec arrête la chaîne au lieu de la poursuivre', () => {
  const team = fresh();
  // Coder sur un plan qui n'existe pas ne produit que du bruit, et coûte deux turns.
  for (const outcome of ['error', 'stopped']) {
    const d = team.next('plan', outcome);
    assert.equal(d.action, 'stop');
    assert.match(d.why, /Plan/);
  }
  assert.equal(team.next('build', 'error').action, 'stop');
});

test('seule l’étape de réalisation est isolée', () => {
  const team = fresh();
  // Le relecteur lit la branche depuis le dépôt principal : sans ça, supprimer la
  // conversation du codeur emporterait le worktree sous ses pieds.
  assert.equal(team.isolates('plan'), false);
  assert.equal(team.isolates('build'), true);
  assert.equal(team.isolates('review'), false);
});

test('une équipe se retrouve depuis n’importe laquelle de ses conversations', () => {
  const team = fresh();
  const run = team.open({ ticketId: 't1', ticketTitle: 'A', project: '/p', provider: 'claude' });
  team.attach(run.id, 'plan', 'conv-plan');
  team.attach(run.id, 'build', 'conv-build');

  assert.equal(team.forConv('conv-plan').stage, 'plan');
  assert.equal(team.forConv('conv-build').run.id, run.id);
  assert.equal(team.forConv('inconnue'), null);
});

test('attacher une étape avance l’équipe sans perdre les précédentes', () => {
  const team = fresh();
  const run = team.open({ ticketId: 't1', ticketTitle: 'A', project: '/p', provider: 'claude' });
  team.attach(run.id, 'plan', 'c1');
  const after = team.attach(run.id, 'build', 'c2');
  assert.equal(after.stage, 'build');
  assert.deepEqual(after.convs, { plan: 'c1', build: 'c2' });
});

test('la consigne du planificateur lui interdit de coder', () => {
  const team = fresh();
  const p = team.planPrompt(TICKET);
  // Le mode d'échec le plus courant de ce genre de chaîne.
  assert.match(p, /planifier, pas de/);
  assert.match(p, /ne modifie aucun fichier/);
  assert.match(p, /Refondre le hero/);
});

test('le codeur reçoit le plan, et sa branche quand il en a une', () => {
  const team = fresh();
  const avec = team.buildPrompt(TICKET, 'étape 1 : lire', 'agenthub/abc123');
  assert.match(avec, /étape 1 : lire/);
  assert.match(avec, /agenthub\/abc123/);
  assert.match(avec, /commite ton travail/);
  // Projet non versionné : pas de branche inventée.
  const sans = team.buildPrompt(TICKET, 'plan', null);
  assert.match(sans, /n’est pas versionné/);
  assert.doesNotMatch(sans, /branche `/);
});

test('un plan manquant ne bloque pas le codeur', () => {
  const team = fresh();
  assert.match(team.buildPrompt(TICKET, '', 'b'), /aucun plan/);
});

test('le relecteur reçoit la commande de diff et l’interdiction d’écrire', () => {
  const team = fresh();
  const r = team.reviewPrompt(TICKET, 'agenthub/abc', 'main');
  assert.match(r, /git diff main\.\.\.agenthub\/abc/);
  assert.match(r, /ne modifie rien/);
  assert.match(r, /Ne réécris pas le code/);
});

test('oublier un ticket retire ses équipes', () => {
  const team = fresh();
  team.open({ ticketId: 't1', ticketTitle: 'A', project: '/p', provider: 'claude' });
  team.open({ ticketId: 't2', ticketTitle: 'B', project: '/p', provider: 'claude' });
  assert.equal(team.forget('t1'), 1);
  assert.deepEqual(team.list().map((r) => r.ticketId), ['t2']);
});
