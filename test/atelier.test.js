'use strict';

// Atelier des skills.
//
// Ce que ces tests protègent : la consigne est tout ce que l'agent aura pour écrire au bon
// endroit et dans le bon format. Un chemin oublié et il écrit dans le dossier courant, où
// aucun CLI ne lira sa skill ; le frontmatter oublié et la skill est invisible sans le moindre
// message d'erreur. Et une session reprise chez le mauvais fournisseur fait échouer le turn
// au lancement.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Le module lit et écrit dans `data/` : on le fait travailler dans un dossier jetable, pour ne
// pas toucher au fil réel de l'atelier.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-atelier-'));
process.env.AGENTHUB_DATA = scratch;

const atelier = require('../lib/atelier');

const INVENTORY = {
  cwd: '/var/www/projet',
  globalRoot: '/home/moi/.claude/skills',
  projectRoot: '/var/www/projet/.claude/skills',
  skills: [
    { name: 'deployer', scope: 'global', description: 'Déploie le site', editable: true },
    { name: 'ce-commit', scope: 'plugin', description: 'Commit', editable: false },
  ],
};

test('la consigne dit où écrire, dans les deux portées', () => {
  const prompt = atelier.buildPrompt({ message: 'crée une skill', inventory: INVENTORY });
  assert.ok(prompt.includes('/home/moi/.claude/skills/<nom>/SKILL.md'), prompt);
  assert.ok(prompt.includes('/var/www/projet/.claude/skills/<nom>/SKILL.md'), prompt);
});

test('sans projet choisi, la consigne le dit au lieu d’inventer un chemin', () => {
  const prompt = atelier.buildPrompt({
    message: 'x',
    inventory: { ...INVENTORY, cwd: null, projectRoot: null },
  });
  assert.ok(/aucun projet choisi/i.test(prompt), prompt);
});

test('la consigne porte le frontmatter, et exige que le nom colle au dossier', () => {
  const prompt = atelier.buildPrompt({ message: 'x', inventory: INVENTORY });
  assert.ok(prompt.includes('name: nom-en-minuscules-avec-tirets'), prompt);
  assert.ok(prompt.includes('description: une seule ligne'), prompt);
  assert.ok(/identique au `name`/.test(prompt), prompt);
});

test('les skills modifiables sont listées, les skills de plugin non', () => {
  const prompt = atelier.buildPrompt({ message: 'x', inventory: INVENTORY });
  assert.ok(prompt.includes('/deployer [global]'), prompt);
  assert.ok(!prompt.includes('/ce-commit ['), prompt);
  // Mais l'interdiction d'y toucher, elle, est dite.
  assert.ok(/fournies par un plugin ne sont pas modifiables/i.test(prompt), prompt);
});

test("l'agent est chargé d'écrire les fichiers, pas de dicter un texte", () => {
  const prompt = atelier.buildPrompt({ message: 'x', inventory: INVENTORY });
  assert.ok(/Écris directement les fichiers/i.test(prompt), prompt);
  assert.ok(/relis son fichier/i.test(prompt), prompt);
});

test('les échanges précédents sont rappelés, et bornés', () => {
  const messages = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    text: `échange ${i}`,
  }));
  const prompt = atelier.buildPrompt({ message: 'et maintenant ?', inventory: INVENTORY, messages });
  assert.ok(prompt.includes('échange 19'), prompt);
  assert.ok(!prompt.includes('échange 5'), prompt);
});

test('le fil se souvient, et se remet à zéro', () => {
  atelier.reset();
  atelier.remember('user', 'crée une skill de déploiement');
  atelier.remember('assistant', 'écrit dans /deployer');
  const kept = atelier.state();
  assert.equal(kept.messages.length, 2);
  assert.equal(kept.messages[0].role, 'user');
  assert.equal(atelier.reset().messages.length, 0);
});

test('une session ne se reprend que chez le fournisseur qui l’a ouverte', () => {
  atelier.reset();
  assert.equal(atelier.resumable('claude'), null);
  atelier.keepSession('claude', 'sess-1');
  assert.equal(atelier.resumable('claude'), 'sess-1');
  // Changer de fournisseur en cours d'atelier arrive : une skill écrite par l'un se relit
  // chez l'autre. Reprendre la session de Claude chez Codex ferait échouer le turn.
  assert.equal(atelier.resumable('codex'), null);
});

test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
