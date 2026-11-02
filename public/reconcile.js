'use strict';

// Décider quoi toucher dans une liste, séparément du fait de le toucher.
//
// La barre latérale était repeinte d'un `innerHTML` complet à chaque événement. Le remède est
// de ne remplacer que les blocs qui changent — mais c'est justement là qu'on se trompe : un
// bloc identique qu'on remplace quand même rejoue son animation, un bloc déplacé qu'on
// reconstruit perd son état, et un ordre mal calculé fait osciller la liste sans fin.
//
// Cette décision-là ne dépend pas du DOM. On la sort donc dans une fonction pure, testable
// sans navigateur, et il ne reste au DOM qu'à exécuter des ordres déjà vérifiés.

/**
 * Compare l'état posé à l'état voulu et renvoie la liste des gestes à faire.
 *
 * @param {{key: string, html: string}[]} placed ce qui est à l'écran, dans l'ordre
 * @param {{key: string, html: string}[]} wanted ce qu'on veut à l'écran, dans l'ordre
 * @returns {{op: 'remove'|'insert'|'replace'|'move'|'keep', key: string, after: string|null}[]}
 *   `after` est la clé du bloc qui doit précéder celui-ci, ou null pour la première place.
 */
function planPaint(placed, wanted) {
  const ops = [];
  const wantedKeys = new Set(wanted.map((b) => b.key));

  // Retraits d'abord : les positions se raisonnent ensuite sur une liste déjà purgée, sinon
  // un bloc sur le départ compterait comme voisin légitime et on calculerait de faux
  // déplacements.
  const survivors = [];
  for (const block of placed) {
    if (wantedKeys.has(block.key)) survivors.push(block);
    else ops.push({ op: 'remove', key: block.key, after: null });
  }

  const htmlOf = new Map(survivors.map((b) => [b.key, b.html]));
  // Ordre courant, tenu à jour au fil des gestes : c'est ce qui permet de savoir si un bloc
  // est déjà à sa place, et donc de ne rien faire — le cas le plus fréquent, et le seul qui
  // compte pour la fluidité.
  const order = survivors.map((b) => b.key);

  let previous = null;
  for (const block of wanted) {
    const known = htmlOf.has(block.key);
    const at = order.indexOf(block.key);
    const expected = previous === null ? 0 : order.indexOf(previous) + 1;

    /** Où le bloc doit atterrir, une fois l'ordre courant purgé de sa position actuelle. */
    const landing = () => (previous === null ? 0 : order.indexOf(previous) + 1);

    if (!known) {
      ops.push({ op: 'insert', key: block.key, after: previous });
      order.splice(expected, 0, block.key);
    } else if (htmlOf.get(block.key) !== block.html) {
      // Un remplacement pose aussi le bloc à sa place : pas de déplacement à ajouter derrière.
      ops.push({ op: 'replace', key: block.key, after: previous });
      if (at !== expected) {
        order.splice(at, 1);
        order.splice(landing(), 0, block.key);
      }
    } else if (at !== expected) {
      ops.push({ op: 'move', key: block.key, after: previous });
      order.splice(at, 1);
      order.splice(landing(), 0, block.key);
    } else {
      ops.push({ op: 'keep', key: block.key, after: previous });
    }
    previous = block.key;
  }

  return ops;
}

/** Les gestes qui touchent réellement au DOM — `keep` n'en est pas un. */
function paintWork(ops) {
  return ops.filter((o) => o.op !== 'keep');
}

if (typeof module !== 'undefined' && module.exports) module.exports = { planPaint, paintWork };
