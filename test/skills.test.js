'use strict';

// Catalogue et portées des skills.
//
// Le socle de tout ce module est une mesure : les skills marchent déjà. Claude et Grok
// déroulent `/nom` envoyé sur stdin et lisent le même dossier ; Codex ne sait pas, d'où le
// déroulement côté agentHub. Ces tests protègent la partie qui nous appartient — la portée,
// le déroulement, et le fait de ne jamais avaler un message.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-skills-'));
process.env.AGENTHUB_DATA = DATA;

const skills = require('../lib/skills');

const PROJET = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-projet-'));

test('le catalogue retient ce que le CLI a publié, et ne réécrit pas pour rien', () => {
  assert.equal(skills.remember('claude', { commands: ['create-pr', 'clear'] }), true);
  assert.equal(
    skills.remember('claude', { commands: ['clear', 'create-pr'] }),
    false,
    'même liste dans un autre ordre : rien à réécrire'
  );
  assert.equal(skills.remember('claude', { commands: [] }), false, 'une liste vide n’efface pas');
});

test('les commandes du TUI sont écartées de l’autocomplétion', () => {
  const names = skills.list('claude').skills.map((s) => s.name);
  assert.ok(names.includes('create-pr'));
  assert.equal(names.includes('clear'), false, '`/clear` ne veut rien dire en headless');
});

test('un fournisseur jamais vu répond une liste vide, pas une erreur', () => {
  assert.deepEqual(skills.list('codex'), { provider: 'codex', seenAt: null, skills: [] });
});

test('le préfixe de plugin sert de regroupement', () => {
  skills.remember('grok', { commands: ['compound-engineering:ce-commit', 'create-pr'] });
  const found = skills.list('grok').skills;
  assert.equal(found.find((s) => s.name.includes(':')).group, 'compound-engineering');
  assert.equal(found.find((s) => s.name === 'create-pr').group, null);
});

// --- Portées ---------------------------------------------------------------

test('une skill créée est lisible, avec sa portée', () => {
  const done = skills.create({
    name: 'ma-skill',
    description: 'Fait quelque chose de précis.',
    body: '# Mode opératoire\n\n1. Lire\n2. Agir',
    scope: 'global',
  });
  assert.equal(done.error, undefined);
  assert.equal(done.scope, 'global');

  const found = skills.inventory(PROJET).skills.find((s) => s.name === 'ma-skill');
  assert.equal(found.scope, 'global');
  assert.equal(found.description, 'Fait quelque chose de précis.');
});

test('un nom qui ne peut pas être un dossier est refusé', () => {
  for (const name of ['Ma Skill', 'ma/skill', '-x', 'a', '']) {
    assert.ok(skills.create({ name, description: 'd', body: 'b' }).error, `nom « ${name} »`);
  }
});

test('une skill sans description ni corps est refusée', () => {
  assert.match(skills.create({ name: 'vide-a', description: '', body: 'b' }).error, /description/);
  assert.match(skills.create({ name: 'vide-b', description: 'd', body: '' }).error, /vide/);
});

test('déplacer une skill de global vers un projet, et revenir', () => {
  assert.equal(skills.move('ma-skill', 'global', 'project', PROJET).scope, 'project');
  assert.ok(fs.existsSync(path.join(PROJET, '.claude', 'skills', 'ma-skill', 'SKILL.md')));

  const inv = skills.inventory(PROJET).skills.find((s) => s.name === 'ma-skill');
  assert.equal(inv.scope, 'project');

  assert.equal(skills.move('ma-skill', 'project', 'global', PROJET).scope, 'global');
});

test('un déplacement impossible le dit au lieu de perdre la skill', () => {
  assert.match(skills.move('ma-skill', 'global', 'global', PROJET).error, /Même portée/);
  assert.match(skills.move('inconnue', 'global', 'project', PROJET).error, /introuvable/);
  assert.match(skills.move('ma-skill', 'global', 'project', null).error, /dossier de travail/);
});

test('une skill de projet masque son homonyme global, et c’est dit', () => {
  skills.create({ name: 'doublon', description: 'globale', body: 'g', scope: 'global' });
  skills.create({ name: 'doublon', description: 'du projet', body: 'p', scope: 'project', cwd: PROJET });

  const found = skills.inventory(PROJET).skills.filter((s) => s.name === 'doublon');
  assert.equal(found.length, 2);
  assert.equal(found.find((s) => s.scope === 'global').shadowed, true);
});

// --- Déroulement pour Codex ------------------------------------------------

test('Claude et Grok déroulent eux-mêmes : le texte part intact', () => {
  for (const provider of ['claude', 'grok']) {
    assert.equal(skills.expand(provider, '/ma-skill fais le', PROJET), '/ma-skill fais le');
  }
});

test('pour Codex, la skill est déroulée dans le prompt', () => {
  const out = skills.expand('codex', '/ma-skill', PROJET);
  assert.ok(out.includes('# Mode opératoire'), out.slice(0, 120));
  assert.ok(out.includes('ma-skill'));
  assert.equal(out.includes('---\nname:'), false, 'le frontmatter ne sert pas à l’agent');
});

test('l’argument qui suit la commande est transmis', () => {
  const out = skills.expand('codex', '/ma-skill en mode brouillon', PROJET);
  assert.ok(out.includes('en mode brouillon'), out);
});

test('la skill du projet prime sur la globale, comme chez les CLIs', () => {
  const out = skills.expand('codex', '/doublon', PROJET);
  assert.ok(out.includes('p'), out);
});

test('une commande inconnue repart telle quelle plutôt qu’avalée', () => {
  // Mieux vaut un agent qui répond « je ne connais pas » qu'un message disparu.
  assert.equal(skills.expand('codex', '/inexistante', PROJET), '/inexistante');
  assert.equal(skills.expand('codex', 'bonjour', PROJET), 'bonjour');
  assert.equal(skills.expand('codex', 'voir /ma-skill plus bas', PROJET), 'voir /ma-skill plus bas');
});

test('supprimer une skill la retire du disque', () => {
  assert.equal(skills.remove('doublon', 'project', PROJET).removed, 'doublon');
  assert.equal(
    skills.inventory(PROJET).skills.filter((s) => s.name === 'doublon').length,
    1,
    'la globale reste'
  );
  assert.match(skills.remove('doublon', 'project', PROJET).error, /introuvable/);
});

test.after(() => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(PROJET, { recursive: true, force: true });
  // Les skills créées en portée globale vivent dans le vrai ~/.claude : on les retire.
  for (const name of ['ma-skill', 'doublon']) skills.remove(name, 'global', null);
});

test('une skill sans frontmatter est décrite par son titre', () => {
  // Une bonne partie des skills réelles commencent directement par leur titre : renvoyer
  // null pour celles-là rendait l'autocomplétion muette sur la moitié du catalogue.
  const dir = path.join(PROJET, '.claude', 'skills', 'sans-front');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# sans-front — un raccourci\r\n\r\ndu texte\r\n');
  skills.forgetDescriptions();

  const found = skills.inventory(PROJET).skills.find((s) => s.name === 'sans-front');
  assert.equal(found.description, 'sans-front — un raccourci');
});
