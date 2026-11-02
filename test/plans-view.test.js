'use strict';

// Le rendu du tiroir des plans : markdown vers HTML.
//
// Testé à part de `lib/plans.js` parce que c'est du code de navigateur, et testable quand même
// parce que la moitié qui rend est pure — voir la frontière posée dans `public/plans.js`.
//
// Deux risques concentrent l'attention. **L'échappement** : un plan est un fichier du dépôt,
// écrit par des agents, et son contenu finit dans le DOM de l'application — un `<script>` dans
// un plan ne doit jamais devenir un `<script>` dans la page. Et **les tableaux**, parce que les
// plans de ce dépôt en sont pleins et qu'un tableau raté rend un document illisible.

const test = require('node:test');
const assert = require('node:assert');

const view = require('../public/plans');

// --- Échappement ----------------------------------------------------------

test('le html d un document est echappe, pas interprete', () => {
  const html = view.markdown('Voir <script>alert(1)</script> et <b>gras</b>.');
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, /&lt;script&gt;/);
});

test('un titre de section ne peut pas injecter de balise', () => {
  assert.doesNotMatch(view.markdown('# <img src=x onerror=alert(1)>'), /<img/);
});

// Le code d'un diagramme part dans un attribut : un guillemet mal échappé le ferme et laisse
// le reste devenir du balisage.
test('le code d un diagramme est echappe dans son attribut', () => {
  const html = view.markdown('```mermaid\nflowchart LR\n  A["gui\\"llemet"] --> B\n```');
  assert.match(html, /data-mermaid="/);
  assert.doesNotMatch(html, /data-mermaid="[^"]*"[a-z]/);
});

test('un lien garde noopener', () => {
  const html = view.markdown('Voir [le site](https://exemple.fr).');
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /target="_blank"/);
});

// --- Structure ------------------------------------------------------------

test('le frontmatter n est pas rendu comme du contenu', () => {
  const html = view.markdown('---\ntitle: Un plan\nstatus: draft\n---\n\n# Un plan\n\nDu texte.');
  assert.doesNotMatch(html, /status/);
  assert.match(html, /<h1[^>]*>Un plan<\/h1>/);
});

test('les titres sont hierarchises', () => {
  const html = view.markdown('# un\n## deux\n### trois');
  assert.match(html, /<h1 class="doc-h doc-h1">un<\/h1>/);
  assert.match(html, /<h2 class="doc-h doc-h2">deux<\/h2>/);
  assert.match(html, /<h3 class="doc-h doc-h3">trois<\/h3>/);
});

test('les listes a puces et numerotees sont distinguees', () => {
  assert.match(view.markdown('- un\n- deux'), /<ul class="doc-list">/);
  assert.match(view.markdown('1. un\n2. deux'), /<ol class="doc-list">/);
});

// Les plans de ce dépôt sont écrits à la marge dure : rendre chaque retour à la ligne
// couperait chaque phrase en deux.
test('des lignes consecutives forment un seul paragraphe', () => {
  const html = view.markdown('Une phrase coupee\nsur deux lignes.');
  assert.match(html, /<p>Une phrase coupee sur deux lignes\.<\/p>/);
  assert.equal(html.match(/<p>/g).length, 1);
});

test('une ligne vide separe deux paragraphes', () => {
  const html = view.markdown('Premier.\n\nSecond.');
  assert.equal(html.match(/<p>/g).length, 2);
});

// --- Blocs de code et diagrammes ------------------------------------------

test('un bloc de code n est pas relu comme du markdown', () => {
  const html = view.markdown('```sh\n- pas une puce\n# pas un titre\n```');
  assert.doesNotMatch(html, /<li>/);
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /<pre><code data-lang="sh">/);
});

// Le point qui rend la seconde moitié de la fonctionnalité possible : un schéma dans un plan.
test('un bloc mermaid devient un conteneur a dessiner, code source compris', () => {
  const html = view.markdown('```mermaid\nerDiagram\n  A ||--o{ B : x\n```');
  assert.match(html, /class="doc-diagram" data-mermaid=/);
  // Le source reste dans le conteneur : c'est ce qui s'affiche si mermaid échoue ou n'est pas
  // encore chargé.
  assert.match(html, /doc-diagram-src">erDiagram/);
});

test('un bloc mermaid n est pas rendu comme du code ordinaire', () => {
  assert.doesNotMatch(view.markdown('```mermaid\nflowchart LR\n A --> B\n```'), /<code data-lang/);
});

test('les cloture en tilde sont reconnues comme celles en accent grave', () => {
  assert.match(view.markdown('~~~js\nconst a = 1;\n~~~'), /<pre><code data-lang="js">/);
});

// Régression. Le bug : la clôture en accents graves était fermée par une recherche de « ~~~ »,
// donc jamais ; le premier bloc avalait tout le reste du document. Invisible pour les tests
// ci-dessus, qui plaçaient tous la clôture en fin de texte — d'où celui-ci, où il y a du
// contenu après.
test('ce qui suit un bloc ferme est rendu, et pas avale par lui', () => {
  const html = view.markdown('```js\nconst a = 1;\n```\n\n## Après\n\nDu texte après.');
  assert.match(html, /<h2 class="doc-h doc-h2">Après<\/h2>/);
  assert.match(html, /<p>Du texte après\.<\/p>/);
  assert.equal(html.match(/<pre>/g).length, 1);
});

test('deux blocs mermaid dans un document donnent deux diagrammes', () => {
  const html = view.markdown(
    '## Un\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n' +
      '## Deux\n\n```mermaid\nsequenceDiagram\n  A->>B: x\n```\n\nFin.'
  );
  assert.equal(html.match(/data-mermaid=/g).length, 2);
  // Et le second diagramme ne doit pas contenir le titre qui le précède.
  assert.doesNotMatch(html, /data-mermaid="[^"]*## Deux/);
  assert.match(html, /<p>Fin\.<\/p>/);
});

test('une cloture plus longue n est pas fermee par une plus courte', () => {
  const html = view.markdown('````\nvoici ``` dedans\n````\n\nAprès.');
  assert.match(html, /voici ``` dedans/);
  assert.match(html, /<p>Après\.<\/p>/);
});

// --- Tableaux -------------------------------------------------------------

test('un tableau devient un table, en-tete comprise', () => {
  const html = view.markdown('| Champ | Type |\n| --- | --- |\n| id | int |\n| nom | texte |');
  assert.match(html, /<table class="doc-table">/);
  assert.match(html, /<th[^>]*>Champ<\/th>/);
  assert.match(html, /<td[^>]*>int<\/td>/);
  assert.equal(html.match(/<tr>/g).length, 3);
});

test('l alignement d une colonne est repris', () => {
  const html = view.markdown('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |');
  assert.match(html, /text-align:center/);
  assert.match(html, /text-align:right/);
});

// Une barre verticale dans une phrase ne fait pas un tableau, et le confondre couperait le
// paragraphe en cellules.
test('une barre isolee dans du texte ne fabrique pas de tableau', () => {
  const html = view.markdown('On lance `a | b` dans un tuyau.');
  assert.doesNotMatch(html, /<table/);
  assert.match(html, /<p>/);
});

test('la mise en forme dans une cellule est rendue', () => {
  const html = view.markdown('| a |\n| --- |\n| du `code` et du **gras** |');
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<strong>gras<\/strong>/);
});

// --- Cases à cocher -------------------------------------------------------

test('les cases a cocher sont rendues, et desactivees', () => {
  const html = view.markdown('- [ ] a faire\n- [x] fait');
  assert.match(html, /<input type="checkbox" disabled>/);
  assert.match(html, /<input type="checkbox" disabled checked>/);
  assert.match(html, /class="doc-task done"/);
});

// Cliquer une case promettrait d'écrire dans le fichier, ce qui n'arrive pas : on modifie un
// plan en passant en édition.
test('aucune case n est cliquable', () => {
  const html = view.markdown('- [ ] a\n- [x] b');
  assert.equal((html.match(/disabled/g) || []).length, 2);
});

// --- Citations et filets --------------------------------------------------

test('une citation sur plusieurs lignes est regroupee', () => {
  const html = view.markdown('> une remarque\n> qui continue');
  assert.match(html, /<blockquote class="doc-quote">une remarque qui continue<\/blockquote>/);
});

test('un filet est rendu', () => {
  assert.match(view.markdown('a\n\n---\n\nb'), /<hr class="doc-hr">/);
});

// --- Mise en forme dans une ligne -----------------------------------------

test('le code en ligne protege ce qu il contient', () => {
  const html = view.markdown('Voir `**pas du gras**` ici.');
  assert.match(html, /<code>\*\*pas du gras\*\*<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
});

test('gras, italique et barre sont rendus', () => {
  assert.match(view.markdown('du **gras**'), /<strong>gras<\/strong>/);
  assert.match(view.markdown('de l *italique*'), /<em>italique<\/em>/);
  assert.match(view.markdown('du ~~barre~~'), /<del>barre<\/del>/);
});

// --- Badges et sous-titres ------------------------------------------------

test('les badges donnent le statut, le type et les natures de schema', () => {
  const badges = view.badges({ status: 'en-cours', type: 'feat', kinds: ['MCD', 'Séquence'] });
  assert.deepEqual(
    badges.map((b) => b.text),
    ['en-cours', 'feat', 'MCD', 'Séquence']
  );
  assert.equal(badges[0].cls, 'st-doing');
});

test('un document sans metadonnees n a aucun badge', () => {
  assert.deepEqual(view.badges({ kinds: [] }), []);
});

test('le sous-titre annonce le nombre de schemas au pluriel juste', () => {
  assert.match(view.subtitle({ date: '2026-08-01', path: 'a.md', diagrams: 1 }), /1 schéma$/);
  assert.match(view.subtitle({ date: '2026-08-01', path: 'a.md', diagrams: 3 }), /3 schémas$/);
  assert.doesNotMatch(view.subtitle({ date: '2026-08-01', path: 'a.md', diagrams: 0 }), /schéma/);
});

// --- Cas dégradés ---------------------------------------------------------

test('un document vide ou nul ne casse pas le rendu', () => {
  assert.equal(view.markdown(''), '');
  assert.equal(view.markdown(null), '');
  assert.equal(view.markdown(undefined), '');
});

test('une cloture de code jamais fermee ne perd pas le reste du document', () => {
  const html = view.markdown('# titre\n\n```js\nconst a = 1;');
  assert.match(html, /<h1[^>]*>titre<\/h1>/);
  assert.match(html, /const a = 1;/);
});

test('les retours chariot windows ne laissent pas de residu', () => {
  const html = view.markdown('# titre\r\n\r\n- un\r\n- deux\r\n');
  assert.doesNotMatch(html, /\r/);
  assert.match(html, /<li>un<\/li>/);
});
