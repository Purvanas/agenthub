'use strict';

// Repérer les idées qu'un agent propose, pour en faire des cartes à ajouter d'un clic.
//
// La convention est un marqueur en tête de ligne — `[idée] Titre — description` —, apprise à
// l'agent par `lib/notes.js`. Un marqueur explicite plutôt qu'une devinette sur la forme du
// texte : reconnaître « une idée » dans une liste à puces attraperait aussi la liste des
// fichiers modifiés et celle des étapes d'un plan. Mieux vaut ne rien flaguer que flaguer à
// tort — un bouton « ajouter à la todo » sous une phrase qui n'est pas une proposition se
// remarque immédiatement, et discrédite les vrais.
//
// Le découpage vit ici, hors du DOM, pour être testable sans navigateur : c'est du travail
// sur des chaînes, et ce genre de code ne se plante pas, il se trompe.

/**
 * Marqueur accepté en début de ligne, éventuellement derrière une puce de liste — un agent
 * qui énumère des idées écrit naturellement `- [idée] …`.
 *
 * Tolérant sur l'accent et la casse : le modèle écrit tantôt `[idée]`, tantôt `[idee]`, et
 * refuser la seconde forme rendrait la fonctionnalité aléatoire pour une question de clavier.
 */
const IDEA_LINE = /^[ \t]*(?:[-*+][ \t]+)?\[id[éeè]e\][ \t]*(.+?)[ \t]*$/i;

/** Séparateurs titre / description, par ordre de préférence : tiret cadratin, demi-cadratin. */
const SPLIT = /\s+[—–]\s+/;

const MAX_TITLE = 200;
const MAX_BODY = 5000;

/**
 * Découpe le contenu d'une ligne d'idée en titre et description.
 *
 * Sans séparateur, tout est titre : une idée en trois mots n'a pas de description à donner,
 * et forcer un découpage inventerait un corps vide plus gênant qu'absent.
 */
function split(text) {
  const raw = String(text == null ? '' : text).trim();
  const at = raw.search(SPLIT);
  if (at === -1) return { title: raw.slice(0, MAX_TITLE), body: '' };
  return {
    title: raw.slice(0, at).trim().slice(0, MAX_TITLE),
    body: raw.slice(at).replace(SPLIT, '').trim().slice(0, MAX_BODY),
  };
}

/** Cette ligne porte-t-elle une idée ? */
function match(line) {
  const found = IDEA_LINE.exec(String(line == null ? '' : line));
  if (!found) return null;
  const parts = split(found[1]);
  // Un marqueur seul, sans texte derrière, n'est pas une idée : ce serait une carte vide.
  return parts.title ? parts : null;
}

/** Toutes les idées d'un texte, dans l'ordre où elles y apparaissent. */
function all(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .map(match)
    .filter(Boolean);
}

const ideas = { IDEA_LINE, MAX_TITLE, MAX_BODY, split, match, all };

if (typeof module !== 'undefined' && module.exports) module.exports = ideas;
