'use strict';

// Découverte et classement des dossiers de travail proposés dans l'UI.
// Les défauts vivent dans config/groups.json, les modifications de la page Paramètres dans
// data/settings.json ; l'ensemble est relu à chaque appel, sans redémarrage.

const fs = require('fs');
const path = require('path');
const settings = require('./settings');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'groups.json');

const FALLBACK = {
  newFolderParents: ['.'],
  groups: [{ label: 'Projets', patterns: ['./*'] }],
  exclude: ['node_modules'],
};

// Un nom contenant un caractère de contrôle est toujours un accident de script
// (le serveur a un dossier « package » suivi d'un retour chariot, laissé par un
// script en CRLF), jamais un vrai projet.
function hasControlChars(name) {
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 32 || name.charCodeAt(i) === 127) return true;
  }
  return false;
}

function loadConfig() {
  const conf = settings.read('groups');
  // Sans aucun groupe, le sélecteur de dossier serait vide et on ne pourrait plus créer de
  // conversation : le repli n'est pas une commodité, c'est ce qui garde l'app utilisable.
  return Array.isArray(conf.groups) && conf.groups.length ? conf : FALLBACK;
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function expand(pattern) {
  if (!pattern.endsWith('/*')) return isDir(pattern) ? [pattern] : [];
  const parent = pattern.slice(0, -2);
  try {
    return fs
      .readdirSync(parent, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !hasControlChars(e.name))
      .map((e) => path.join(parent, e.name));
  } catch {
    return [];
  }
}

function listGroups() {
  const config = loadConfig();
  const excludes = (config.exclude || []).map((r) => new RegExp(r, 'i'));
  const seen = new Set();
  const groups = [];

  for (const group of config.groups || []) {
    const projects = [];
    for (const pattern of group.patterns || []) {
      for (const dir of expand(pattern)) {
        const name = path.basename(dir);
        if (seen.has(dir)) continue; // un groupe plus prioritaire l'a déjà pris
        if (excludes.some((re) => re.test(name))) continue;
        seen.add(dir);
        projects.push({ path: dir, name, git: isDir(path.join(dir, '.git')) });
      }
    }
    projects.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    groups.push({ label: group.label, projects });
  }

  return { groups, newFolderParents: config.newFolderParents || [] };
}

/**
 * Crée un dossier de projet. Le parent doit figurer dans newFolderParents :
 * sans ça, l'API laisserait créer un dossier n'importe où sur le disque.
 */
function createFolder(parent, name) {
  const config = loadConfig();
  const allowed = config.newFolderParents || [];
  if (!allowed.includes(parent)) {
    throw new Error(`Parent non autorisé : ${parent}`);
  }
  if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) {
    throw new Error('Nom invalide (lettres, chiffres, . _ - uniquement)');
  }
  const full = path.join(parent, name);
  if (fs.existsSync(full)) throw new Error(`${full} existe déjà`);
  fs.mkdirSync(full, { recursive: false });
  return { path: full, name, git: false };
}

module.exports = { listGroups, createFolder };
