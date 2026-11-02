'use strict';

// Réconciliation de la barre latérale.
//
// Ces tests existent pour une raison précise : le défaut qu'ils préviennent est invisible à la
// lecture et très visible à l'écran. Repeindre un bloc inchangé rejoue son animation, et c'est
// exactement ce qui donnait un glissement du bas vers le haut en permanence. Le cas qui compte
// le plus n'est donc pas « le rendu est-il juste » mais « combien de gestes fait-on », et
// `planPaint` est la seule chose à interroger là-dessus puisqu'elle décide sans toucher au DOM.

const test = require('node:test');
const assert = require('node:assert');

const { planPaint, paintWork } = require('../public/reconcile');

/** Raccourci : une liste de blocs à partir de `clé=html`. */
const blocks = (...pairs) =>
  pairs.map((p) => {
    const at = p.indexOf('=');
    return at === -1 ? { key: p, html: p } : { key: p.slice(0, at), html: p.slice(at + 1) };
  });

/** L'ordre final obtenu en appliquant les gestes, pour vérifier qu'ils mènent au bon état. */
function apply(placed, ops) {
  const order = placed.map((b) => b.key);
  for (const op of ops) {
    if (op.op === 'remove') {
      order.splice(order.indexOf(op.key), 1);
      continue;
    }
    if (op.op === 'keep') continue;
    const at = order.indexOf(op.key);
    if (at !== -1) order.splice(at, 1);
    order.splice(op.after === null ? 0 : order.indexOf(op.after) + 1, 0, op.key);
  }
  return order;
}

test('une liste identique ne demande aucun geste', () => {
  const list = blocks('pinned', 'folder:a', 'loose');
  const ops = planPaint(list, list);
  assert.deepEqual(paintWork(ops), [], 'c’est le cas courant : aucun événement ne doit repeindre');
});

test('seul le bloc dont le HTML change est remplacé', () => {
  const before = blocks('pinned=A', 'folder:a=B', 'loose=C');
  const after = blocks('pinned=A', 'folder:a=B2', 'loose=C');
  const work = paintWork(planPaint(before, after));
  assert.equal(work.length, 1);
  assert.deepEqual(work[0], { op: 'replace', key: 'folder:a', after: 'pinned' });
});

test('un bloc ajouté est inséré après son prédécesseur, sans toucher aux autres', () => {
  const before = blocks('pinned', 'loose');
  const after = blocks('pinned', 'folder:neuf', 'loose');
  const ops = planPaint(before, after);
  const work = paintWork(ops);
  assert.equal(work.length, 1);
  assert.deepEqual(work[0], { op: 'insert', key: 'folder:neuf', after: 'pinned' });
  assert.deepEqual(apply(before, ops), ['pinned', 'folder:neuf', 'loose']);
});

test('un bloc disparu est retiré, et lui seul', () => {
  const before = blocks('pinned', 'folder:a', 'loose');
  const after = blocks('pinned', 'loose');
  const work = paintWork(planPaint(before, after));
  assert.deepEqual(work, [{ op: 'remove', key: 'folder:a', after: null }]);
});

test('un premier bloc inséré vise la première place', () => {
  const before = blocks('loose');
  const after = blocks('pinned', 'loose');
  const ops = planPaint(before, after);
  assert.deepEqual(paintWork(ops), [{ op: 'insert', key: 'pinned', after: null }]);
  assert.deepEqual(apply(before, ops), ['pinned', 'loose']);
});

// Le glisser-déposer de dossiers repose entièrement sur ce cas : réordonner doit déplacer, pas
// reconstruire, sinon le contenu des dossiers clignote à chaque déplacement.
test('réordonner déplace sans jamais remplacer', () => {
  const before = blocks('folder:a=A', 'folder:b=B', 'folder:c=C');
  const after = blocks('folder:c=C', 'folder:a=A', 'folder:b=B');
  const ops = planPaint(before, after);
  const work = paintWork(ops);
  assert.ok(
    work.every((o) => o.op === 'move'),
    `aucun remplacement attendu, obtenu : ${JSON.stringify(work)}`
  );
  assert.deepEqual(apply(before, ops), ['folder:c', 'folder:a', 'folder:b']);
});

test('un déplacement d’un seul dossier ne bouge que lui', () => {
  const before = blocks('folder:a', 'folder:b', 'folder:c');
  const after = blocks('folder:b', 'folder:a', 'folder:c');
  const work = paintWork(planPaint(before, after));
  assert.equal(work.length, 1, `un seul geste attendu, obtenu : ${JSON.stringify(work)}`);
  assert.deepEqual(work[0], { op: 'move', key: 'folder:b', after: null });
});

test('un remplacement et un déplacement simultanés restent cohérents', () => {
  const before = blocks('a=1', 'b=2', 'c=3');
  const after = blocks('c=3', 'b=2bis', 'a=1');
  const ops = planPaint(before, after);
  assert.deepEqual(apply(before, ops), ['c', 'b', 'a']);
  assert.ok(
    ops.some((o) => o.op === 'replace' && o.key === 'b'),
    'b a changé de contenu : il doit être remplacé'
  );
});

test('vider la liste retire tout et n’insère rien', () => {
  const before = blocks('a', 'b');
  const ops = planPaint(before, []);
  assert.deepEqual(
    ops.map((o) => o.op),
    ['remove', 'remove']
  );
});

test('partir d’une liste vide insère dans l’ordre', () => {
  const ops = planPaint([], blocks('a', 'b', 'c'));
  assert.deepEqual(ops, [
    { op: 'insert', key: 'a', after: null },
    { op: 'insert', key: 'b', after: 'a' },
    { op: 'insert', key: 'c', after: 'b' },
  ]);
  assert.deepEqual(apply([], ops), ['a', 'b', 'c']);
});

test('un bloc retiré et un bloc ajouté au même endroit ne perturbent pas les voisins', () => {
  // Cas réel : un dossier supprimé et un autre créé entre deux rafraîchissements.
  const before = blocks('pinned=P', 'folder:vieux=V', 'loose=L');
  const after = blocks('pinned=P', 'folder:neuf=N', 'loose=L');
  const ops = planPaint(before, after);
  const work = paintWork(ops);
  assert.deepEqual(
    work.map((o) => `${o.op}:${o.key}`).sort(),
    ['insert:folder:neuf', 'remove:folder:vieux'],
    'ni pinned ni loose ne doivent être touchés'
  );
  assert.deepEqual(apply(before, ops), ['pinned', 'folder:neuf', 'loose']);
});
