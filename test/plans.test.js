'use strict';

// Plans et schémas d'un projet.
//
// Ce module lit et écrit des fichiers **du projet**, pas de `data/` : ce sont donc les gardes
// autour de ces fichiers qui décident si la fonctionnalité est sûre, et le classement qui
// décide si elle sert à quelque chose. Les tests portent sur ces deux choses, plus l'extraction
// des diagrammes dont dépend toute la seconde moitié de l'interface.
//
// Chaque test travaille dans un vrai dossier temporaire. Simuler `fs` aurait rendu le test
// aveugle à ce qu'on veut justement vérifier — qu'un `..` ne sorte pas du dossier.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plans = require('../lib/plans');

/** Un projet jetable, garni de fichiers. Rend son chemin racine. */
function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-plans-'));
  for (const [rel, content] of Object.entries(files || {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const PLAN = [
  '---',
  'title: "feat: Relais entre agents"',
  'type: feat',
  'status: in-progress',
  'date: 2026-08-01',
  '---',
  '',
  '# feat: Relais entre agents',
  '',
  '## Conception',
  '',
  '```mermaid',
  'sequenceDiagram',
  '    A->>B: coucou',
  '```',
  '',
].join('\n');

// --- La garde de chemin ----------------------------------------------------
//
// Le test le plus important du fichier. Une écriture qui sort du projet, sur une application
// sans authentification qui tourne sous un compte à sudo, n'est pas un bug d'affichage.

test('un chemin qui sort du projet est refuse', () => {
  const root = project({ 'README.md': '# ok' });
  for (const bad of [
    '../../etc/passwd',
    '/etc/passwd',
    'docs/../../evasion.md',
    '../voisin/README.md',
    './../../x.md',
  ]) {
    assert.equal(plans.resolve(root, bad), null, `« ${bad} » aurait dû être refusé`);
  }
});

test('un chemin dans le projet est accepte, et seulement pour une extension connue', () => {
  const root = project({ 'README.md': '# ok' });
  assert.equal(plans.resolve(root, 'README.md'), path.join(root, 'README.md'));
  assert.equal(plans.resolve(root, 'docs/plans/x.mmd'), path.join(root, 'docs/plans/x.mmd'));
  // Un `.env` ou un `.js` n'a rien à faire dans un tiroir de plans, et le refuser ici est ce
  // qui empêche que l'éditeur devienne un éditeur de code arbitraire.
  for (const bad of ['.env', 'server.js', 'data/notes.json']) {
    assert.equal(plans.resolve(root, bad), null, `« ${bad} » aurait dû être refusé`);
  }
});

// Le préfixe doit inclure le séparateur, sinon un dossier voisin dont le nom commence pareil
// passe pour un enfant.
test('un dossier voisin au nom proche ne passe pas pour un enfant', () => {
  const root = project({ 'README.md': '# ok' });
  assert.equal(plans.resolve(root, `../${path.basename(root)}-vieux/README.md`), null);
});

test('ecrire refuse de creer, et refuse de sortir du projet', () => {
  const root = project({ 'docs/plans/a.md': PLAN });
  assert.throws(() => plans.write(root, '../evade.md', 'x'), /hors du projet/);
  assert.throws(() => plans.write(root, 'docs/plans/inconnu.md', 'x'), /n'existe pas/);
});

// --- Le classement --------------------------------------------------------

test('les documents sont ranges par section, pas en vrac', () => {
  const root = project({
    'README.md': '# projet',
    'docs/plans/a.md': PLAN,
    'docs/brainstorms/b.md': '# cadrage',
    'docs/schemas/c.mmd': 'erDiagram\n  A ||--o{ B : x',
    'docs/solutions/d.md': '# une solution',
  });
  const sections = plans.list(root);
  assert.deepEqual(
    sections.map((s) => s.id),
    ['plans', 'cadrages', 'schemas', 'docs', 'racine']
  );
  // `docs` ramasse le reste de `docs/` : le plan ne doit pas y apparaître une seconde fois.
  assert.deepEqual(
    sections.find((s) => s.id === 'docs').docs.map((d) => d.path),
    ['docs/solutions/d.md']
  );
});

test('une section vide n est pas rendue', () => {
  const root = project({ 'README.md': '# projet' });
  assert.deepEqual(
    plans.list(root).map((s) => s.id),
    ['racine']
  );
});

// Ce qui est en cours passe avant ce qui est fini : c'est tout l'intérêt de lire le statut.
test('dans une section, en-cours passe avant termine', () => {
  const root = project({
    'docs/plans/fini.md': '---\nstatus: completed\ndate: 2026-08-09\n---\n# fini',
    'docs/plans/encours.md': '---\nstatus: wip\ndate: 2026-08-01\n---\n# en cours',
    'docs/plans/brouillon.md': '---\nstatus: draft\ndate: 2026-08-05\n---\n# brouillon',
  });
  const docs = plans.list(root).find((s) => s.id === 'plans').docs;
  assert.deepEqual(
    docs.map((d) => d.status),
    ['en-cours', 'brouillon', 'terminé']
  );
});

test('a statut egal, le plus recent est en tete', () => {
  const root = project({
    'docs/plans/vieux.md': '---\nstatus: draft\ndate: 2026-01-01\n---\n# vieux',
    'docs/plans/neuf.md': '---\nstatus: draft\ndate: 2026-08-10\n---\n# neuf',
  });
  assert.deepEqual(
    plans.list(root)
      .find((s) => s.id === 'plans')
      .docs.map((d) => d.path),
    ['docs/plans/neuf.md', 'docs/plans/vieux.md']
  );
});

// Un document sans frontmatter ne doit pas tomber sous les plans finis : la plupart des
// markdown d'un projet n'en ont pas, et les reléguer les rendrait invisibles.
test('un document sans statut se place avant les termines', () => {
  const root = project({
    'docs/plans/fini.md': '---\nstatus: done\ndate: 2026-08-10\n---\n# fini',
    'docs/plans/nu.md': '# sans frontmatter',
  });
  assert.deepEqual(
    plans.list(root)
      .find((s) => s.id === 'plans')
      .docs.map((d) => d.path),
    ['docs/plans/nu.md', 'docs/plans/fini.md']
  );
});

test('un dossier lourd est ignore au parcours', () => {
  const root = project({
    'docs/plans/a.md': PLAN,
    'node_modules/paquet/README.md': '# pas un plan',
    'data/notes.md': '# pas un plan',
  });
  const paths = plans.list(root).flatMap((s) => s.docs.map((d) => d.path));
  assert.deepEqual(paths, ['docs/plans/a.md']);
});

// --- Le frontmatter -------------------------------------------------------

test('le frontmatter lit les cles simples et retire les guillemets', () => {
  const meta = plans.frontmatter(PLAN);
  assert.equal(meta.title, 'feat: Relais entre agents');
  assert.equal(meta.status, 'in-progress');
});

// Le « # » est un commentaire YAML sur une valeur nue, et du texte entre guillemets.
test('un diese est un commentaire hors guillemets, du texte dedans', () => {
  const meta = plans.frontmatter('---\na: valeur # commentaire\nb: "corrige #12"\n---\n');
  assert.equal(meta.a, 'valeur');
  assert.equal(meta.b, 'corrige #12');
});

// Les deux conventions coexistent dans ce dépôt : `docs/plans` écrit `title`,
// `docs/solutions` écrit `titre`.
test('les cles en francais sont acceptees comme celles en anglais', () => {
  const root = project({
    'docs/solutions/fr.md': '---\ntitre: Un piège\nstatut: terminé\n---\ncorps',
  });
  const doc = plans.list(root).find((s) => s.id === 'docs').docs[0];
  assert.equal(doc.title, 'Un piège');
  assert.equal(doc.status, 'terminé');
});

test('les statuts inconnus ne font pas disparaitre le document', () => {
  assert.equal(plans.status('n-importe-quoi'), 'autre');
  assert.equal(plans.status(''), null);
});

test('le titre vient du frontmatter, sinon du titre h1, sinon du nom de fichier', () => {
  const root = project({
    'docs/plans/2026-08-01-001-feat-le-relais-plan.md': 'pas de titre ici',
    'docs/plans/avec-h1.md': '# Le vrai titre',
  });
  const docs = plans.list(root).find((s) => s.id === 'plans').docs;
  const byPath = Object.fromEntries(docs.map((d) => [d.path, d.title]));
  assert.equal(byPath['docs/plans/avec-h1.md'], 'Le vrai titre');
  // La date et le numéro d'ordre sortent du titre affiché : sans ça toute la liste
  // commencerait par la même colonne de chiffres.
  assert.equal(byPath['docs/plans/2026-08-01-001-feat-le-relais-plan.md'], 'feat le relais');
});

// --- Les schémas ----------------------------------------------------------

test('un bloc mermaid est extrait d un markdown, avec sa nature', () => {
  const blocks = plans.mermaidBlocks(PLAN);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'Séquence');
  assert.match(blocks[0].code, /A->>B: coucou/);
});

test('le titre d un bloc vient du dernier titre markdown au-dessus', () => {
  assert.equal(plans.mermaidBlocks(PLAN)[0].title, 'Conception');
});

test('la nature du diagramme est lue sur son premier mot-cle', () => {
  const cases = {
    'erDiagram\n A ||--o{ B : x': 'MCD',
    'sequenceDiagram\n A->>B: x': 'Séquence',
    'classDiagram\n class A': 'Classes',
    'stateDiagram-v2\n [*] --> A': 'États',
    'flowchart LR\n A --> B': 'Graphe',
    'graph TD\n A --> B': 'Graphe',
  };
  for (const [code, kind] of Object.entries(cases)) {
    assert.equal(plans.diagramKind(code), kind, code.split('\n')[0]);
  }
});

// Un en-tête de configuration ou un commentaire avant le mot-clé ne doit pas masquer la nature.
test('un frontmatter ou un commentaire avant le mot-cle ne masque pas la nature', () => {
  assert.equal(plans.diagramKind('---\ntitle: MCD\n---\nerDiagram\n A ||--o{ B : x'), 'MCD');
  assert.equal(plans.diagramKind('%% un commentaire\nsequenceDiagram\n A->>B: x'), 'Séquence');
});

test('un fichier .mmd est un schema a lui tout seul', () => {
  const root = project({ 'docs/schemas/mcd.mmd': 'erDiagram\n  CLIENT ||--o{ COMMANDE : passe' });
  const doc = plans.list(root).find((s) => s.id === 'schemas').docs[0];
  assert.equal(doc.mermaid, true);
  assert.deepEqual(doc.kinds, ['MCD']);
});

// L'onglet Schémas doit montrer les diagrammes enfermés dans un plan, sinon la moitié des
// schémas d'un projet resteraient invisibles.
test('les diagrammes d un plan apparaissent aussi dans la liste des schemas', () => {
  const root = project({
    'docs/plans/a.md': PLAN,
    'docs/schemas/mcd.mmd': 'erDiagram\n  A ||--o{ B : x',
  });
  const found = plans.diagrams(root);
  assert.deepEqual(
    found.map((d) => `${d.kind}:${d.standalone}`).sort(),
    ['MCD:true', 'Séquence:false']
  );
});

// --- Créer et écrire ------------------------------------------------------

test('un plan cree suit la convention de nommage datee et numerotee', () => {
  const root = project({});
  const first = plans.create(root, { kind: 'plan', title: 'Relais entre agents' });
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(first.path, `docs/plans/${day}-001-relais-entre-agents-plan.md`);
  // Deux plans le même jour ne doivent pas se battre pour le même nom.
  const second = plans.create(root, { kind: 'plan', title: 'Autre chose' });
  assert.equal(second.path, `docs/plans/${day}-002-autre-chose-plan.md`);
});

test('un plan cree se relit avec le statut et le titre que son amorce a poses', () => {
  const root = project({});
  const made = plans.create(root, { kind: 'plan', title: 'Le relais' });
  const back = plans.read(root, made.path);
  assert.equal(back.title, 'Le relais');
  assert.equal(back.status, 'brouillon');
  // L'amorce porte un bloc mermaid : le plan est donc rendu dès sa création.
  assert.equal(back.diagrams.length, 1);
});

test('un schema cree se nomme par son sujet, et se rend des sa creation', () => {
  const root = project({});
  const made = plans.create(root, { kind: 'schema', title: 'MCD boutique', diagram: 'mcd' });
  assert.equal(made.path, 'docs/schemas/mcd-boutique.mmd');
  assert.equal(made.kinds[0], 'MCD');
  // Une collision se règle par un suffixe, pas en écrasant le schéma existant.
  const again = plans.create(root, { kind: 'schema', title: 'MCD boutique', diagram: 'mcd' });
  assert.equal(again.path, 'docs/schemas/mcd-boutique-2.mmd');
});

test('chaque amorce de diagramme est reconnue par son propre analyseur', () => {
  for (const [name, code] of Object.entries(plans.DIAGRAMS)) {
    assert.notEqual(plans.diagramKind(code), 'Diagramme', `l'amorce « ${name} » n'a pas de nature`);
  }
});

test('un titre sans caractere utilisable ne casse pas la creation', () => {
  const root = project({});
  const made = plans.create(root, { kind: 'schema', title: '???' });
  assert.equal(made.path, 'docs/schemas/sans-titre.mmd');
});

test('ecrire remplace le contenu et rend la fiche a jour', () => {
  const root = project({ 'docs/plans/a.md': PLAN });
  const after = plans.write(
    root,
    'docs/plans/a.md',
    '---\ntitle: Nouveau titre\nstatus: completed\n---\n# Nouveau titre\n'
  );
  assert.equal(after.title, 'Nouveau titre');
  assert.equal(after.status, 'terminé');
  assert.equal(fs.readFileSync(path.join(root, 'docs/plans/a.md'), 'utf8').includes('coucou'), false);
});

// L'écriture est atomique, donc elle ne doit laisser aucun fichier temporaire derrière elle :
// dans un dépôt suivi par git, un résidu salit la copie de travail et bloque le déploiement.
test('ecrire ne laisse pas de fichier temporaire', () => {
  const root = project({ 'docs/plans/a.md': PLAN });
  plans.write(root, 'docs/plans/a.md', '# court');
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs/plans')), ['a.md']);
});

// --- Ce que l'agent voit --------------------------------------------------

test('le prompt donne les conventions meme sans aucun plan', () => {
  const block = plans.promptBlock(project({}));
  assert.match(block, /docs\/plans/);
  assert.match(block, /docs\/schemas/);
  assert.match(block, /erDiagram/);
});

test('le prompt annonce les plans existants avec leur statut', () => {
  const root = project({ 'docs/plans/a.md': PLAN, 'docs/schemas/mcd.mmd': 'erDiagram\n A ||--o{ B : x' });
  const block = plans.promptBlock(root);
  assert.match(block, /docs\/plans\/a\.md \(status: en-cours — Séquence\)/);
  assert.match(block, /docs\/schemas\/mcd\.mmd/);
});

// Le ton compte autant que le contenu : un agent en autonomie qui découvre un plan
// « brouillon » se met à l'implémenter de lui-même.
test('le prompt dit de ne pas travailler sur un plan sans demande', () => {
  const block = plans.promptBlock(project({ 'docs/plans/a.md': PLAN }));
  assert.match(block, /que si on te le demande/);
});

// Les deux sections fourre-tout coûteraient des lignes à chaque turn pour une information qui ne
// concerne pas la tâche : elles restent affichées dans le tiroir, pas annoncées dans le prompt.
test('le prompt n annonce ni la racine ni le reste de docs', () => {
  const block = plans.promptBlock(
    project({
      'README.md': '# projet',
      'docs/solutions/un-piege.md': '# un piège',
      'docs/plans/a.md': PLAN,
    })
  );
  assert.doesNotMatch(block, /README\.md/);
  assert.doesNotMatch(block, /un-piege\.md/);
  // Mais le plan, lui, est bien annoncé : c'est un document de conception.
  assert.match(block, /docs\/plans\/a\.md/);
});

test('sans projet, le prompt n ajoute rien', () => {
  assert.equal(plans.promptBlock(null), '');
  assert.equal(plans.promptBlock(''), '');
});

// --- Cas dégradés ---------------------------------------------------------

test('un projet qui n existe pas rend une liste vide, sans lever', () => {
  assert.deepEqual(plans.list('/tmp/aucun-projet-de-ce-nom'), []);
  assert.deepEqual(plans.list(null), []);
});

test('lire un document absent rend null', () => {
  assert.equal(plans.read(project({}), 'docs/plans/absent.md'), null);
});

test('un projet se retrouve depuis une conversation isolee par son depot principal', () => {
  assert.equal(plans.projectOf({ cwd: '.' }), '.');
  // Le worktree porte les fichiers, mais les plans du projet sont ceux du projet : sinon
  // chaque branche aurait son jeu de plans.
  assert.equal(
    plans.projectOf({ cwd: './data/worktrees/x', worktree: { repo: '.' } }),
    '.'
  );
  assert.equal(plans.projectOf(null), null);
});

test('une barre finale ne change pas la cle du projet', () => {
  assert.equal(plans.key('./'), '.');
  assert.equal(plans.key('.'), '.');
});
