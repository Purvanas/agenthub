'use strict';

// Exclusions du dépôt fantôme.
//
// La règle vérifiée ici est celle qui empêche une conversation travaillant sur agentHub
// lui-même d'archiver `data/` — donc les dépôts fantômes des autres conversations, que le
// motif `.git/` n'attrape pas parce qu'ils s'appellent `<uuid>.git`.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cp-'));
const DATA = path.join(ROOT, 'data');
process.env.AGENTHUB_DATA = DATA;

const checkpoints = require('../lib/checkpoints');

test('le dossier de données est repéré quand il est sous le dossier suivi', () => {
  assert.equal(checkpoints.dataRelative(ROOT), 'data');
  assert.equal(checkpoints.dataRelative(path.join(ROOT, '.')), 'data');
});

test("il est ignoré quand il est ailleurs, ce qui est le cas courant", () => {
  assert.equal(checkpoints.dataRelative('/var/www/autre-projet'), null);
  assert.equal(checkpoints.dataRelative(path.join(ROOT, 'sous-dossier')), null);
});

test('un dossier de travail qui EST le dossier de données est reconnu comme tel', () => {
  assert.equal(checkpoints.dataRelative(DATA), '');
});

test('le motif ajouté est ancré à la racine du work-tree', () => {
  const excludes = checkpoints.excludesFor(ROOT);
  assert.ok(excludes.includes('/data/'));
  // Ancré : un `data/` situé plus bas dans le projet suivi reste archivé.
  assert.ok(!excludes.includes('data/'));
  // Les exclusions d'origine sont conservées.
  for (const base of checkpoints.EXCLUDES) assert.ok(excludes.includes(base), base);
});

test("un projet ordinaire garde exactement la liste d'origine", () => {
  assert.deepEqual(checkpoints.excludesFor('/var/www/autre-projet'), checkpoints.EXCLUDES);
});

test('un dossier de travail confondu avec les données exclut tout', () => {
  assert.ok(checkpoints.excludesFor(DATA).includes('/*'));
});

test('le dépôt réel du projet suivi reste exclu en premier', () => {
  // Sans barre finale : dans un worktree, `.git` est un fichier et non un dossier, et un
  // motif ancré sur les répertoires le laissait passer.
  assert.equal(checkpoints.EXCLUDES[0], '.git');
});

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));
