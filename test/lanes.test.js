'use strict';

// Placement des commits en colonnes.
//
// C'est le seul endroit du panneau git où une erreur produit un dessin faux plutôt qu'une
// panne visible : un trait qui manque, une colonne qui s'élargit sans raison, une fusion qui
// perd une de ses deux entrées. Les topologies ci-dessous sont écrites à la main pour couvrir
// ce qu'un dépôt réel ne produit qu'occasionnellement.
//
// Convention des fixtures, comme celle de git : du plus récent au plus ancien, et le PREMIER
// parent est la continuation de la branche.

const test = require('node:test');
const assert = require('node:assert');

const { assignLanes, firstFree } = require('../lib/lanes');

/** Raccourci de fixture : `c('b', 'a')` = le commit b, enfant de a. */
const c = (sha, ...parents) => ({ sha, parents });

/** Les traits sous forme comparable : d'où, dans quelle lane, vers où. */
const edgeList = (out) =>
  out.edges.map((e) => `${e.fromRow}:${e.fromCol} -[${e.lane}]-> ${e.toRow === null ? 'bas' : `${e.toRow}:${e.toCol}`}`);

const colOf = (out, sha) => out.rows.find((r) => r.sha === sha).col;

test('une histoire linéaire tient dans une seule colonne', () => {
  const out = assignLanes([c('d', 'c'), c('c', 'b'), c('b', 'a'), c('a')]);

  assert.equal(out.columns, 1);
  assert.deepEqual(out.rows.map((r) => r.col), [0, 0, 0, 0]);
  assert.deepEqual(edgeList(out), [
    '0:0 -[0]-> 1:0',
    '1:0 -[0]-> 2:0',
    '2:0 -[0]-> 3:0',
  ]);
});

test('le dernier commit sans parent ne laisse pas de trait qui pend', () => {
  const out = assignLanes([c('b', 'a'), c('a')]);
  assert.equal(out.edges.filter((e) => e.toRow === null).length, 0);
  assert.equal(out.rows[1].root, true);
});

test('une branche latérale prend la colonne suivante et la rend en se refermant', () => {
  // b et c partent tous deux de a : c est un sommet de branche, il ouvre la colonne 1.
  const out = assignLanes([c('b', 'a'), c('c', 'a'), c('a')]);

  assert.equal(colOf(out, 'b'), 0);
  assert.equal(colOf(out, 'c'), 1);
  assert.equal(colOf(out, 'a'), 0);
  assert.equal(out.columns, 2);

  // Les deux traits convergent sur a, chacun gardant sa lane de descente.
  assert.deepEqual(edgeList(out), ['0:0 -[0]-> 2:0', '1:1 -[1]-> 2:0']);
});

test('une fusion garde ses deux entrées, dans deux lanes distinctes', () => {
  //   m (fusion de a et b)
  //   |\
  //   a b
  //   |/
  //   r
  const out = assignLanes([c('m', 'a', 'b'), c('a', 'r'), c('b', 'r'), c('r')]);

  assert.equal(colOf(out, 'm'), 0);
  assert.equal(out.rows[0].merge, true);

  // Le premier parent continue dans la lane du commit, le second en ouvre une.
  assert.deepEqual(edgeList(out), [
    '0:0 -[0]-> 1:0',
    '0:0 -[1]-> 2:1',
    '1:0 -[0]-> 3:0',
    '2:1 -[1]-> 3:0',
  ]);
});

test('un octopus ouvre une lane par parent supplémentaire', () => {
  const out = assignLanes([c('m', 'a', 'b', 'd'), c('a', 'r'), c('b', 'r'), c('d', 'r'), c('r')]);

  assert.equal(out.rows[0].merge, true);
  assert.equal(out.columns, 3);
  assert.deepEqual(out.rows.map((r) => r.col), [0, 0, 1, 2, 0]);
  // Trois traits partent de la fusion, un par parent.
  assert.equal(out.edges.filter((e) => e.fromRow === 0).length, 3);
});

test('deux fusions vers le même parent gardent chacune son trait', () => {
  // Le piège : la lane qui attend `r` est réutilisée, mais si le second lien réutilisait
  // aussi le TRAIT du premier, un des deux liens disparaîtrait du dessin.
  const out = assignLanes([c('m1', 'a', 'r'), c('m2', 'b', 'r'), c('a', 'r'), c('b', 'r'), c('r')]);

  const towardsR = out.edges.filter((e) => e.toRow === 4);
  assert.equal(towardsR.length, 4, 'quatre liens visent r : m1, m2, a et b');
  // Chacun part bien de sa propre ligne.
  assert.deepEqual(towardsR.map((e) => e.fromRow).sort(), [0, 1, 2, 3]);
});

test('une colonne libérée est réutilisée plutôt qu’une nouvelle ouverte', () => {
  // La branche `s` occupe la colonne 1 puis se referme sur `a`. La branche `t`, plus bas,
  // doit reprendre cette colonne 1 : sinon le graphe s'élargit à chaque branche refermée.
  const out = assignLanes([c('b', 'a'), c('s', 'a'), c('a', 'z'), c('t', 'z'), c('z')]);

  assert.equal(colOf(out, 's'), 1);
  assert.equal(colOf(out, 't'), 1);
  assert.equal(out.columns, 2);
});

test('un parent hors fenêtre laisse un trait qui sort par le bas', () => {
  // Fenêtre tronquée : le parent `a` n'a pas été demandé.
  const out = assignLanes([c('c', 'b'), c('b', 'a')]);

  const dangling = out.edges.filter((e) => e.toRow === null);
  assert.equal(dangling.length, 1);
  assert.equal(dangling[0].fromRow, 1);
  assert.equal(dangling[0].toCol, null);
});

test('plusieurs sommets de branche sans parent commun coexistent', () => {
  const out = assignLanes([c('x'), c('y'), c('z')]);
  assert.deepEqual(out.rows.map((r) => r.col), [0, 0, 0]);
  assert.equal(out.columns, 1);
  assert.equal(out.edges.length, 0);
});

test('un croisement de fusions reste placé sans perdre de lien', () => {
  // Deux branches qui se fusionnent mutuellement — le motif « criss-cross », que git produit
  // quand deux lignes de travail se rattrapent l'une l'autre.
  const out = assignLanes([
    c('m1', 'a', 'b'),
    c('m2', 'b', 'a'),
    c('a', 'r'),
    c('b', 'r'),
    c('r'),
  ]);

  assert.equal(out.rows.length, 5);
  // Chaque lien de parenté déclaré doit produire exactement un trait.
  const declared = 2 + 2 + 1 + 1;
  assert.equal(out.edges.filter((e) => e.toRow !== null).length, declared);
  assert.equal(out.edges.filter((e) => e.toRow === null).length, 0);
});

test('chaque lien de parenté produit un trait, sur une topologie plus large', () => {
  // Garde-fou général : aucun lien ne doit se perdre, quelle que soit la forme.
  const commits = [
    c('h', 'g', 'f'),
    c('g', 'e'),
    c('f', 'e', 'd'),
    c('e', 'c'),
    c('d', 'c'),
    c('c', 'b'),
    c('b', 'a'),
    c('a'),
  ];
  const out = assignLanes(commits);

  const known = new Set(commits.map((x) => x.sha));
  const expected = commits.reduce((n, x) => n + x.parents.filter((p) => known.has(p)).length, 0);
  assert.equal(out.edges.filter((e) => e.toRow !== null).length, expected);
});

test('une liste vide ne casse pas et garde une colonne', () => {
  const out = assignLanes([]);
  assert.deepEqual(out.rows, []);
  assert.deepEqual(out.edges, []);
  assert.equal(out.columns, 1);
});

test('firstFree rend la première colonne libre, et en ouvre une au besoin', () => {
  const active = ['a', null, 'c'];
  assert.equal(firstFree(active), 1);

  const full = ['a', 'b'];
  assert.equal(firstFree(full), 2);
  assert.equal(full.length, 3);
});
