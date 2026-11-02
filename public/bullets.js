'use strict';

// Écrire une liste dans le composeur sans écrire ses tirets.
//
// Le champ est un `<textarea>` : il ne sait pas mettre en forme son contenu, et le remplacer
// par une zone `contenteditable` coûterait tout le reste (collage d'images, dictée,
// redimensionnement) — c'est déjà la raison pour laquelle les skills s'annoncent par un badge
// plutôt qu'en colorant le texte. Ce qu'on peut faire, en revanche, c'est **le caractère** :
// « - » suivi d'une espace devient « • », qui se lit comme une puce dans le champ.
//
// Ce qui part à l'agent reste du markdown : `toMarkdown` remet les tirets à l'envoi. La puce
// est donc une aide à la lecture pendant la frappe, et jamais une syntaxe inventée que
// l'agent devrait deviner.
//
// Chaque décision est rendue sous forme de **remplacement** — de tel caractère à tel autre,
// par tel texte — et non de nouveau contenu du champ. C'est ce qui permet à l'appelant de
// passer par la saisie du navigateur et de garder la pile d'annulation : réécrire `value`
// entièrement la vide, et Ctrl+Z ne rend alors plus rien de ce qui a été tapé avant. La
// décision elle-même reste hors du DOM, donc testable sans navigateur — du code qui déplace
// un curseur dans une chaîne ne se plante pas, il se trompe.

/** La puce, espace comprise : c'est le motif complet qui remplace « - ». */
const BULLET = '• ';

/** Début de la ligne où se trouve le curseur. */
function lineStart(value, caret) {
  return value.lastIndexOf('\n', caret - 1) + 1;
}

/**
 * L'espace qui vient d'être frappée ouvre-t-elle une puce ?
 *
 * Uniquement derrière un tiret (ou une étoile) seul en début de ligne : « 3 - 4 » ne doit
 * évidemment rien devenir. L'indentation est conservée, une liste imbriquée gardant son
 * décalage.
 *
 * @param {string} value contenu du champ, avant insertion de l'espace
 * @param {number} caret position du curseur
 * @returns {{from: number, to: number, text: string}|null} null quand il n'y a rien à faire
 */
function onSpace(value, caret) {
  const start = lineStart(value, caret);
  const found = /^([ \t]*)([-*])$/.exec(value.slice(start, caret));
  if (!found) return null;
  return { from: start + found[1].length, to: caret, text: BULLET };
}

/**
 * Le saut de ligne dans une liste continue la liste.
 *
 * Deux cas, et c'est le second qui fait la différence à l'usage : sur une puce restée vide, le
 * saut de ligne **sort** de la liste au lieu d'en ajouter une de plus. Sans ça, il faudrait
 * effacer à la main la puce qu'on vient de recevoir, à chaque fois.
 *
 * @returns {{from: number, to: number, text: string}|null} null quand la ligne n'est pas une
 *   puce — le champ fait alors son saut de ligne ordinaire, personne n'a à s'en mêler.
 */
function onNewline(value, caret) {
  const start = lineStart(value, caret);
  const found = new RegExp(`^([ \\t]*)${BULLET}(.*)$`).exec(value.slice(start, caret));
  if (!found) return null;
  const [, indent, content] = found;

  // Puce vide : on l'efface et on saute la ligne. La liste est finie.
  if (!content.trim()) return { from: start, to: caret, text: '\n' };

  return { from: caret, to: caret, text: `\n${indent}${BULLET}` };
}

/**
 * L'effacement juste derrière une puce enlève la puce entière.
 *
 * Sinon un retour arrière laisse « • » sans son espace, qui n'est plus une puce mais un
 * caractère perdu au milieu du texte — et qu'il faut effacer une deuxième fois.
 */
function onBackspace(value, caret) {
  const start = lineStart(value, caret);
  const found = new RegExp(`^([ \\t]*)${BULLET}$`).exec(value.slice(start, caret));
  if (!found) return null;
  return { from: start + found[1].length, to: caret, text: '' };
}

/**
 * Applique un remplacement. Sert aux tests, et au navigateur qui refuserait la saisie
 * programmée — auquel cas on écrit dans le champ, au prix de son annulation.
 *
 * @returns {{value: string, caret: number}}
 */
function apply(value, edit) {
  if (!edit) return { value, caret: value.length };
  return {
    value: value.slice(0, edit.from) + edit.text + value.slice(edit.to),
    caret: edit.from + edit.text.length,
  };
}

/**
 * Ce qui part réellement à l'agent : du markdown.
 *
 * Les puces ne valent que dans le champ. Un agent reçoit des tirets, la forme que tout le
 * monde écrit et que le fil sait déjà rendre en liste.
 */
function toMarkdown(value) {
  return String(value == null ? '' : value).replace(
    new RegExp(`^([ \\t]*)${BULLET}`, 'gm'),
    '$1- '
  );
}

// Un seul nom, ici comme dans le navigateur : ce fichier est chargé en script classique, donc
// ses déclarations de tête sont déjà globales — les regrouper évite d'en semer six.
const bullets = { BULLET, onSpace, onNewline, onBackspace, apply, toMarkdown };

if (typeof module !== 'undefined' && module.exports) module.exports = bullets;
