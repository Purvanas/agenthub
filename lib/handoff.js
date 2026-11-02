'use strict';

// Note de passation : ce qu'un agent transmet à un autre quand le fil ne peut pas voyager.
//
// Deux raisons pour lesquelles il ne peut pas. Les fenêtres de contexte ne se
// ressemblent pas — 1 M chez Opus 5, 500 K chez Grok Build — donc un fil long ne rentre
// pas forcément chez le suivant. Et deux fournisseurs différents ne partagent aucun
// format de session, donc il n'y a rien à reprendre directement. Passer la main veut donc
// dire écrire, pas copier.
//
// Les notes sont rangées avec les données d'agentHub et non dans le dossier de travail :
// les y écrire les rendrait visibles et versionnables, au prix de polluer des dépôts pro
// avec des artefacts d'outillage. Elles sont transmises par chemin absolu, que les trois
// CLIs lisent sans difficulté.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const NOTES_DIR = path.join(DATA_DIR, 'handoffs');

fs.mkdirSync(NOTES_DIR, { recursive: true });

/**
 * Consigne fixe posée à l'agent sortant. La structure est imposée : une note libre est
 * agréable à lire et inutilisable, l'agent entrant a besoin de savoir où il en est, pas
 * d'un récit.
 */
const REQUEST = [
  "Tu passes la main à un autre agent, qui n'aura accès ni à cette conversation ni à ton",
  'contexte. Rédige une note de passation en markdown, et rien d\'autre : pas de',
  'préambule, pas de conclusion, pas de commentaire sur la note elle-même.',
  '',
  'Structure attendue, dans cet ordre :',
  '',
  '## Objectif',
  "Ce qu'il s'agit d'obtenir, en quelques lignes.",
  '',
  '## Décisions prises',
  'Les choix déjà arrêtés et pourquoi, pour ne pas les rouvrir.',
  '',
  '## Ce qui reste à faire',
  'Les étapes restantes, dans l\'ordre où les prendre.',
  '',
  '## Pièges',
  "Ce qui a déjà échoué, ce qui est contre-intuitif, ce qui casse si on n'y pense pas.",
  '',
  '## Fichiers touchés',
  'Les chemins concernés et le rôle de chacun.',
  '',
  "N'écris aucun fichier et ne lance aucune commande : réponds uniquement par la note.",
].join('\n');

/** Chemin du fichier de note d'une conversation, horodaté pour ne jamais en écraser une. */
function notePath(parentId, at) {
  const stamp = at.replace(/[:.]/g, '-');
  return path.join(NOTES_DIR, `${parentId}-${stamp}.md`);
}

/**
 * Écrit la note produite par l'agent sortant.
 * @returns {string} chemin absolu du fichier écrit
 */
function write(parentId, text) {
  const at = new Date().toISOString();
  const file = notePath(parentId, at);
  const header = `<!-- note de passation produite le ${at} par la conversation ${parentId} -->\n\n`;
  fs.writeFileSync(file, `${header}${String(text).trim()}\n`, { mode: 0o600 });
  return file;
}

/** Consigne de démarrage de l'enfant : la note, puis ce que l'utilisateur a demandé. */
function childPrompt(instruction, file) {
  return (
    `${instruction}\n\n` +
    `Note de passation de l'agent précédent : ${file}\n` +
    "Commence par la lire : elle porte tout le contexte dont tu disposes, la conversation " +
    "d'origine ne t'est pas accessible."
  );
}

/** Supprime les notes d'une conversation, quand elle est supprimée. */
function removeConversation(parentId) {
  let entries;
  try {
    entries = fs.readdirSync(NOTES_DIR);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(`${parentId}-`)) {
      fs.rmSync(path.join(NOTES_DIR, name), { force: true });
    }
  }
}

module.exports = { REQUEST, write, childPrompt, removeConversation, NOTES_DIR };
