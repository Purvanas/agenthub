'use strict';

// Placement des commits en colonnes, et tracé des traits entre eux.
//
// C'est le calcul que `git log --graph` offrait gratuitement, et qu'il faut reprendre dès
// qu'on veut dessiner autre chose que son texte. L'algorithme est celui de tous les clients
// git : une liste de « lanes », chacune retenant le sha qu'elle attend. Un commit se dessine
// dans la lane qui l'attendait, son premier parent y reste, ses autres parents ouvrent des
// lanes — et une lane qui n'attend plus rien se libère pour la suivante.
//
// Aucune dépendance ajoutée. `graph-lab` (npm) fait exactement ce calcul et sort du JSON
// sérialisable, ce qui aurait été idéal, mais il est en 0.0.5 **sans champ `license` ni
// fichier de licence** : tous droits réservés par défaut, quoi qu'en dise son README. Son
// propre code étant porté de git-graph-plus (Apache-2.0) et SourceGit (MIT), la méthode est
// libre — c'est ce paquet-là qu'on évite, pas l'algorithme.
//
// Tout est pur : ni git, ni disque, ni horloge. C'est ce qui rend le placement testable sur
// des topologies écrites à la main, y compris celles qu'un dépôt réel produit rarement.

/**
 * Lane libre la plus à gauche, en ouvrant une colonne s'il n'y en a plus.
 *
 * À gauche et non à droite : sans ça le graphe s'élargit indéfiniment au fil des branches
 * refermées, alors que leurs colonnes sont réutilisables.
 */
function firstFree(active) {
  for (let i = 0; i < active.length; i += 1) {
    if (active[i] === null) return i;
  }
  active.push(null);
  return active.length - 1;
}

/**
 * Place une liste de commits en colonnes et en traits.
 *
 * Les traits ne sont pas émis au moment où on les ouvre mais au moment où le commit visé est
 * dessiné : c'est ce qui permet de connaître ses deux extrémités d'un coup, et de traiter
 * de la même façon la continuation d'une branche et l'entrée d'une fusion. Ceux qui restent
 * ouverts à la fin visent un parent hors de la fenêtre demandée — ils sortent par le bas.
 *
 * @param {Array<{sha: string, parents: string[]}>} commits du plus récent au plus ancien
 * @returns {{columns: number, rows: Array, edges: Array}}
 */
function assignLanes(commits) {
  const active = []; // lane -> sha attendu, ou null si libre
  let pending = []; // traits ouverts : { fromRow, fromCol, lane, toSha }
  const rows = [];
  const edges = [];
  let columns = 0;

  (commits || []).forEach((commit, row) => {
    const closing = pending.filter((e) => e.toSha === commit.sha);

    // Les lanes qui attendaient ce commit. Plusieurs enfants peuvent partager un parent :
    // leurs traits convergent ici, et toutes ces lanes sauf une se libèrent.
    const waiting = [...new Set(closing.map((e) => e.lane))];
    for (let i = 0; i < active.length; i += 1) {
      if (active[i] === commit.sha && !waiting.includes(i)) waiting.push(i);
    }
    waiting.sort((a, b) => a - b);

    let col;
    if (waiting.length) {
      // La plus à gauche : le trait principal reste au plus près du bord.
      col = waiting[0];
    } else {
      // Sommet de branche — personne ne l'attendait.
      col = firstFree(active);
      active[col] = commit.sha;
    }

    for (const e of closing) {
      edges.push({ fromRow: e.fromRow, fromCol: e.fromCol, lane: e.lane, toRow: row, toCol: col });
    }
    pending = pending.filter((e) => e.toSha !== commit.sha);

    for (const lane of waiting) {
      if (lane !== col) active[lane] = null;
    }

    rows.push({
      ...commit,
      row,
      col,
      merge: commit.parents.length > 1,
      root: commit.parents.length === 0,
    });

    const [first, ...others] = commit.parents;

    if (first) {
      active[col] = first;
      pending.push({ fromRow: row, fromCol: col, lane: col, toSha: first });
    } else {
      active[col] = null;
    }

    // Les parents suivants sont les entrées de la fusion. Une lane qui attend déjà ce parent
    // est réutilisée — deux fusions vers le même commit partagent alors sa colonne — mais
    // chacune garde SON trait : sinon un des deux liens disparaîtrait du dessin.
    for (const parent of others) {
      let lane = active.indexOf(parent);
      if (lane === -1) {
        lane = firstFree(active);
        active[lane] = parent;
      }
      pending.push({ fromRow: row, fromCol: col, lane, toSha: parent });
    }

    columns = Math.max(columns, active.length);
  });

  // Ce qui reste ouvert vise un parent hors fenêtre : le trait sort par le bas.
  for (const e of pending) {
    edges.push({ fromRow: e.fromRow, fromCol: e.fromCol, lane: e.lane, toRow: null, toCol: null });
  }

  return { columns: Math.max(columns, 1), rows, edges };
}

module.exports = { assignLanes, firstFree };
