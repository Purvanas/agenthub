'use strict';

// Garde-fous des chemins servis par l'API.
//
// Ce sont les deux fonctions qui empêchent le navigateur de demander n'importe quel
// fichier de la machine. Le prédicat d'existence est injecté : un test ne doit pas écrire
// dans le dossier de sessions de Grok, qui vit sous le répertoire personnel.

const test = require('node:test');
const assert = require('node:assert');

const { resolveImage, resolveRelayFile, imageRoots } = require('../lib/paths');

const HOME = '/home/agent';
const CONV = {
  cwd: '/tmp/projet',
  providerSessionId: 'sess-1',
};

const SESSION_DIR = `${HOME}/.grok/sessions/${encodeURIComponent(CONV.cwd)}/sess-1`;

/** Faux disque : seuls ces chemins existent. */
const disk = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

const opts = (isFile) => ({ isFile, homedir: HOME });

test('les deux racines de recherche sont le dossier de travail et la session du provider', () => {
  assert.deepEqual(imageRoots(CONV, HOME), ['/tmp/projet', SESSION_DIR]);
});

test('une image relative est trouvée dans le dossier de travail', () => {
  const found = resolveImage(CONV, 'images/1.jpg', opts(disk('/tmp/projet/images/1.jpg')));
  assert.equal(found, '/tmp/projet/images/1.jpg');
});

test('à défaut, elle est cherchée dans le dossier de session de Grok', () => {
  const found = resolveImage(CONV, 'images/1.jpg', opts(disk(`${SESSION_DIR}/images/1.jpg`)));
  assert.equal(found, `${SESSION_DIR}/images/1.jpg`);
});

test('un chemin absolu est accepté s\'il reste sous une racine autorisée', () => {
  const wanted = '/tmp/projet/sortie/plan.png';
  assert.equal(resolveImage(CONV, wanted, opts(disk(wanted))), wanted);
});

test('une remontée de répertoire est refusée même si le fichier existe', () => {
  const escapes = [
    '../../etc/passwd.png',
    '/etc/hosts.png',
    'images/../../../secrets.png',
  ];
  for (const wanted of escapes) {
    assert.equal(resolveImage(CONV, wanted, opts(() => true)), null, wanted);
  }
});

test('seules les extensions d\'image sont servies', () => {
  for (const wanted of ['package.json', 'notes.md', 'script.sh', 'archive.zip']) {
    assert.equal(resolveImage(CONV, wanted, opts(() => true)), null, wanted);
  }
  assert.equal(resolveImage(CONV, 'a.PNG', opts(disk('/tmp/projet/a.PNG'))), '/tmp/projet/a.PNG');
});

test('une image absente renvoie null plutôt qu\'un chemin optimiste', () => {
  assert.equal(resolveImage(CONV, 'images/absente.png', opts(disk())), null);
});

test('sans session de provider, seule la racine du dossier de travail est essayée', () => {
  const conv = { cwd: '/tmp/projet', providerSessionId: null };
  assert.deepEqual(imageRoots(conv, HOME), ['/tmp/projet']);
  assert.equal(resolveImage(conv, 'x.png', opts(disk(`${SESSION_DIR}/x.png`))), null);
});

// --- Fichier de départ d'un relais ----------------------------------------

test('un markdown du dossier de travail est accepté, relatif comme absolu', () => {
  const file = '/tmp/projet/docs/plan.md';
  assert.equal(resolveRelayFile(CONV, 'docs/plan.md', opts(disk(file))), file);
  assert.equal(resolveRelayFile(CONV, file, opts(disk(file))), file);
});

test('un fichier hors du dossier de travail est refusé', () => {
  for (const wanted of ['../voisin/plan.md', '/etc/passwd', '/tmp/autre/plan.md']) {
    assert.equal(resolveRelayFile(CONV, wanted, opts(() => true)), null, wanted);
  }
});

test('un chemin vide ou un dossier ne sont pas des points de départ', () => {
  assert.equal(resolveRelayFile(CONV, '', opts(() => true)), null);
  assert.equal(resolveRelayFile(CONV, '   ', opts(() => true)), null);
  assert.equal(resolveRelayFile(CONV, 'docs', opts(() => false)), null);
});

test('le dossier de travail lui-même ne remonte pas comme fichier', () => {
  assert.equal(resolveRelayFile(CONV, '/tmp/projet', opts(() => false)), null);
});
