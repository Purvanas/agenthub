'use strict';

// Règles d'un projet : ce qu'il faut faire avant certains gestes.
//
// Deux choses décident du reste et sont testées ici : la recherche par nom, qui doit tolérer
// la façon dont un agent écrira le nom ; et ce que le prompt annonce, qui est la seule chose
// que l'agent verra sans rien demander.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rules-'));
process.env.AGENTHUB_DATA = DATA;

const rules = require('../lib/rules');

const PROJECT = '.';
const PUSH = {
  name: 'git push',
  when: 'avant tout push, quelle que soit la branche',
  body: 'Ne pousse jamais directement sur main. Ouvre une branche, puis préviens par mail.',
};

test.beforeEach(() => fs.rmSync(rules.FILE, { force: true }));

// --- Retrouver une règle ---------------------------------------------------

test('une regle se retrouve par son nom', () => {
  rules.create(PROJECT, PUSH);
  assert.match(rules.find(PROJECT, 'git push').body, /jamais directement sur main/);
});

// Le point qui décide si la fonctionnalité sert à quelque chose : un agent qui écrit
// « Git  Push » et reçoit « aucune règle » conclut qu'il peut y aller.
test('la casse, les accents et les espaces en trop ne font pas rater la regle', () => {
  rules.create(PROJECT, { ...PUSH, name: 'Déploiement' });
  for (const written of ['déploiement', 'DEPLOIEMENT', 'Deploiement', '  deploiement  ']) {
    assert.ok(rules.find(PROJECT, written), `« ${written} » aurait dû trouver la règle`);
  }
});

test('une regle d un autre projet ne repond pas', () => {
  rules.create(PROJECT, PUSH);
  assert.equal(rules.find('/tmp/site', 'git push'), null);
});

// Désactiver doit avoir exactement l'effet de ne pas avoir écrit la règle, sinon on ne sait
// plus ce qui s'applique.
test('une regle desactivee repond comme si elle n existait pas', () => {
  const row = rules.create(PROJECT, PUSH);
  rules.update(row.id, { enabled: false });
  assert.equal(rules.find(PROJECT, 'git push'), null);
  assert.equal(rules.promptBlock(PROJECT), '');
  // Elle reste visible dans l'interface : désactiver n'est pas supprimer.
  assert.equal(rules.list(PROJECT).length, 1);
});

test('un nom vide ne retrouve rien', () => {
  rules.create(PROJECT, PUSH);
  assert.equal(rules.find(PROJECT, ''), null);
  assert.equal(rules.find(PROJECT, '   '), null);
});

// --- Écriture --------------------------------------------------------------

test('un nom ou des instructions vides sont refuses', () => {
  assert.throws(() => rules.create(PROJECT, { name: '', body: 'x' }), /Nom de règle vide/);
  assert.throws(() => rules.create(PROJECT, { name: 'x', body: ' ' }), /Instructions vides/);
});

// Le nom est la clé que l'agent interroge : deux règles homonymes rendraient la réponse
// imprévisible.
test('deux regles du meme nom sont refusees, casse comprise', () => {
  rules.create(PROJECT, PUSH);
  assert.throws(() => rules.create(PROJECT, { ...PUSH, name: 'GIT PUSH' }), /existe déjà/);
  // Un autre projet peut avoir la sienne.
  assert.ok(rules.create('/tmp/site', PUSH));
});

test('renommer une regle vers un nom deja pris est refuse', () => {
  rules.create(PROJECT, PUSH);
  const other = rules.create(PROJECT, { name: 'déploiement', body: 'x' });
  assert.throws(() => rules.update(other.id, { name: 'git push' }), /existe déjà/);
  // Se renommer en soi-même reste possible.
  assert.ok(rules.update(other.id, { name: 'Déploiement', body: 'y' }));
});

test('supprimer une regle, et les regles d un projet entier', () => {
  const row = rules.create(PROJECT, PUSH);
  assert.equal(rules.remove(row.id), true);
  assert.equal(rules.remove(row.id), false);

  rules.create(PROJECT, PUSH);
  rules.create(PROJECT, { name: 'autre', body: 'x' });
  rules.create('/tmp/site', PUSH);
  assert.equal(rules.forgetProject(PROJECT), 2);
  assert.equal(rules.list('/tmp/site').length, 1);
});

// --- Ce que l'agent voit ---------------------------------------------------

test('sans regle, le prompt ne dit rien', () => {
  assert.equal(rules.promptBlock(PROJECT), '');
});

test('une regle ordinaire n annonce que son nom et son moment', () => {
  rules.create(PROJECT, PUSH);
  const block = rules.promptBlock(PROJECT);
  assert.match(block, /- git push — avant tout push/);
  // Le corps n'est PAS dans le prompt : c'est tout le principe, il se lit à la demande.
  assert.equal(block.includes('jamais directement sur main'), false);
  assert.match(block, /AGENTHUB_RULES_URL/);
  // L'exemple de commande est prêt à lancer : un nom à espaces y est déjà encodé.
  assert.match(block, /name=git%20push/);
});

test('une regle « toujours » est recopiee en entier', () => {
  rules.create(PROJECT, { ...PUSH, always: true });
  const block = rules.promptBlock(PROJECT);
  assert.match(block, /jamais directement sur main/);
  // Et elle ne figure pas en plus dans l'index : ce serait la dire deux fois.
  assert.equal(block.includes('- git push —'), false);
});

test('le prompt melange les deux sans se contredire', () => {
  rules.create(PROJECT, { ...PUSH, always: true });
  rules.create(PROJECT, { name: 'déploiement', when: 'avant une mise en ligne', body: 'Détail.' });
  const block = rules.promptBlock(PROJECT);
  assert.match(block, /jamais directement sur main/);
  assert.match(block, /- déploiement — avant une mise en ligne/);
  assert.equal(block.includes('Détail.'), false);
});

test('l index est borne, et le dit', () => {
  for (let i = 0; i < rules.MAX_IN_PROMPT + 3; i += 1) {
    rules.create(PROJECT, { name: `regle ${String(i).padStart(2, '0')}`, body: 'x' });
  }
  const block = rules.promptBlock(PROJECT);
  const listed = block.split('\n').filter((l) => l.startsWith('- regle '));
  assert.equal(listed.length, rules.MAX_IN_PROMPT);
  assert.match(block, /et 3 autre\(s\)/);
});
