'use strict';

// Résolution des chemins de fichiers demandés par le navigateur, et les garde-fous qui
// vont avec. Extrait de `server.js` pour être testable sans lancer de serveur : ces deux
// fonctions sont ce qui empêche l'API de servir n'importe quel fichier de la machine.
//
// Le prédicat `isFile` est injectable pour la même raison : un test ne doit pas avoir à
// écrire dans le dossier de sessions de Grok, qui vit sous le répertoire personnel.

const fs = require('fs');
const os = require('os');
const path = require('path');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

function isFileOnDisk(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function realpathOnDisk(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/** Le chemin résolu est-il sous l'une des racines autorisées ? C'est ce qui bloque `../`. */
function under(candidate, roots) {
  return roots.some((root) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
}

/**
 * Vérifie aussi le chemin réel : `path.resolve` bloque `..`, mais pas un lien symbolique
 * présent dans le projet et pointant vers `/etc` ou un autre dépôt.
 */
function safeExistingFile(candidate, roots, isFile, realpath) {
  if (!under(candidate, roots) || !isFile(candidate)) return false;
  const actual = realpath(candidate);
  if (!actual) return false;
  const actualRoots = roots.map(realpath).filter(Boolean).map((root) => path.resolve(root));
  return under(path.resolve(actual), actualRoots);
}

/**
 * Racines dans lesquelles chercher une image produite par un agent.
 *
 * Le chemin écrit dans un `![alt](chemin)` n'est relatif à rien de connu du navigateur :
 * Grok l'écrit relativement à son dossier de session, Claude et Codex plutôt au dossier
 * de travail.
 */
function imageRoots(conv, homedir = os.homedir()) {
  const roots = [conv.cwd];
  if (conv.providerSessionId) {
    // Convention de Grok : ~/.grok/sessions/<cwd encodé>/<session>/
    roots.push(
      path.join(homedir, '.grok', 'sessions', encodeURIComponent(conv.cwd), conv.providerSessionId)
    );
  }
  return roots.map((r) => path.resolve(r));
}

/**
 * @returns {string|null} chemin absolu sûr d'une image, ou null si introuvable ou refusé.
 */
function resolveImage(conv, wanted, options = {}) {
  if (!wanted || !IMAGE_EXT.has(path.extname(wanted).toLowerCase())) return null;
  const isFile = options.isFile || isFileOnDisk;
  const realpath = options.realpath || realpathOnDisk;
  const roots = imageRoots(conv, options.homedir);

  const candidates = path.isAbsolute(wanted)
    ? [path.resolve(wanted)]
    : roots.map((root) => path.resolve(root, wanted));

  for (const candidate of candidates) {
    if (safeExistingFile(candidate, roots, isFile, realpath)) return candidate;
  }
  return null;
}

/**
 * Fichier de départ d'un relais. Même règle que pour les images, avec une seule racine :
 * le dossier de travail de la conversation.
 * @returns {string|null} chemin absolu, ou null s'il est refusé.
 */
function resolveRelayFile(conv, wanted, options = {}) {
  if (!wanted || !String(wanted).trim()) return null;
  const isFile = options.isFile || isFileOnDisk;
  const realpath = options.realpath || realpathOnDisk;
  const root = path.resolve(conv.cwd);
  const candidate = path.isAbsolute(wanted)
    ? path.resolve(wanted)
    : path.resolve(root, String(wanted).trim());
  return safeExistingFile(candidate, [root], isFile, realpath) ? candidate : null;
}

module.exports = { resolveImage, resolveRelayFile, imageRoots, IMAGE_EXT };
