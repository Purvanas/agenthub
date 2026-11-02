'use strict';

// Galerie d'images générées par les agents.
//
// Volontairement indépendante du reste : ses projets ne sont pas les dossiers de la
// sidebar, et une génération ne crée pas de conversation. Rien de ce qui se passe ici
// n'apparaît dans le fil des conversations.
//
// Une génération est un turn d'agent lancé dans un dossier vide qui lui appartient, avec
// la consigne d'y écrire un fichier image. On ne se fie pas au nom que l'agent annonce :
// ce qui se trouve dans son dossier est le résultat, et il est ensuite rangé dans le
// projet sous un nom unique. C'est ce qui permet de traiter de la même façon Grok, qui a
// un modèle d'image, et Claude ou Codex, qui produisent un SVG ou du code qui rend une
// image.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const ROOT = path.join(DATA_DIR, 'gallery');
const INDEX_FILE = path.join(ROOT, 'index.json');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);

fs.mkdirSync(ROOT, { recursive: true });

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return {
      projects: Array.isArray(raw.projects) ? raw.projects : [],
      images: Array.isArray(raw.images) ? raw.images : [],
    };
  } catch {
    return { projects: [], images: [] };
  }
}

let index = readIndex();
let flushTimer = null;

// Écriture atomique, comme pour l'index des conversations : jamais de JSON tronqué si le
// process meurt en pleine sauvegarde.
function flush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, INDEX_FILE);
}

function schedule() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, 300);
}

function projectDir(projectId) {
  return path.join(ROOT, projectId);
}

// --- Projets ---------------------------------------------------------------

function projects() {
  return index.projects.map((p) => ({
    ...p,
    count: index.images.filter((i) => i.projectId === p.id && i.state === 'done').length,
  }));
}

function getProject(id) {
  return index.projects.find((p) => p.id === id) || null;
}

function createProject(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Nom de projet vide');
  const project = {
    id: crypto.randomUUID(),
    name: clean,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(projectDir(project.id), { recursive: true });
  index.projects.push(project);
  schedule();
  return project;
}

function renameProject(id, name) {
  const project = getProject(id);
  if (!project) return null;
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Nom de projet vide');
  project.name = clean;
  schedule();
  return project;
}

/** Supprime le projet, ses images et son dossier : rien ne survit ailleurs. */
function removeProject(id) {
  const before = index.projects.length;
  index.projects = index.projects.filter((p) => p.id !== id);
  if (index.projects.length === before) return false;
  index.images = index.images.filter((i) => i.projectId !== id);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
  flush();
  return true;
}

// --- Images ----------------------------------------------------------------

function images(projectId) {
  return index.images
    .filter((i) => !projectId || i.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getImage(id) {
  return index.images.find((i) => i.id === id) || null;
}

/**
 * Une génération en attente. Elle existe avant son résultat pour que l'interface montre
 * un emplacement occupé pendant que l'agent travaille, plutôt qu'un vide.
 */
function startImage({ projectId, prompt, provider, model, batchId }) {
  const image = {
    id: crypto.randomUUID(),
    projectId,
    batchId,
    prompt,
    provider,
    model: model || null,
    state: 'working',
    file: null,
    text: null,
    error: null,
    costUsd: 0,
    createdAt: new Date().toISOString(),
  };
  index.images.push(image);
  schedule();
  return image;
}

function finishImage(id, patch) {
  const image = getImage(id);
  if (!image) return null;
  Object.assign(image, patch);
  schedule();
  return image;
}

function removeImage(id) {
  const image = getImage(id);
  if (!image) return false;
  if (image.file) {
    fs.rmSync(path.join(projectDir(image.projectId), image.file), { force: true });
  }
  index.images = index.images.filter((i) => i.id !== id);
  schedule();
  return true;
}

// --- Détection du résultat --------------------------------------------------
//
// Chaque génération travaille dans son propre dossier vide. Comparer le contenu du
// dossier du projet avant et après ne marchait pas : deux agents lancés en parallèle sur
// la même description écrivaient au même endroit, chacun voyait les fichiers de l'autre,
// et deux images distinctes se retrouvaient attribuées au même agent.

/** Dossier de travail d'une génération, vide et à elle seule. */
function genDir(projectId, imageId) {
  return path.join(projectDir(projectId), '.gen', imageId);
}

function prepareGen(projectId, imageId) {
  const dir = genDir(projectId, imageId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Range le résultat dans le projet sous un nom qui ne peut entrer en collision avec
 * personne, et efface le dossier de travail.
 * @returns {string|null} le nom du fichier retenu
 */
function collectGen(projectId, imageId) {
  const dir = genDir(projectId, imageId);
  let produced;
  try {
    produced = fs
      .readdirSync(dir)
      .filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      // Le plus récent d'abord : si l'agent a tâtonné, sa dernière tentative est la bonne.
      .sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  } catch {
    produced = [];
  }

  let kept = null;
  if (produced.length) {
    const ext = path.extname(produced[0]).toLowerCase();
    kept = `${imageId}${ext}`;
    try {
      fs.renameSync(path.join(dir, produced[0]), path.join(projectDir(projectId), kept));
    } catch {
      kept = null;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return kept;
}

/** Chemin absolu d'une image, refusé s'il sort du dossier du projet. */
function resolveFile(image) {
  if (!image || !image.file) return null;
  const dir = path.resolve(projectDir(image.projectId));
  const file = path.resolve(dir, image.file);
  if (file !== dir && !file.startsWith(`${dir}${path.sep}`)) return null;
  return fs.existsSync(file) ? file : null;
}

/** Consigne donnée à l'agent. Elle doit marcher pour un modèle d'image comme pour du code. */
function buildPrompt(description) {
  return [
    "Produis une image à partir de la description ci-dessous et écris-la comme fichier dans",
    'le dossier de travail courant.',
    '',
    `Description : ${description}`,
    '',
    'Contraintes :',
    "- un seul fichier image en sortie, au format png, jpg, webp ou svg",
    "- écris-le directement dans le dossier courant, pas dans un sous-dossier",
    "- n'écris aucun autre fichier",
    '- si tu as un outil de génération d\'image, sers-t\'en ; sinon produis un SVG ou un',
    '  rendu par le code',
    '- réponds en une phrase : ce que tu as produit',
  ].join('\n');
}

module.exports = {
  projects,
  getProject,
  createProject,
  renameProject,
  removeProject,
  images,
  getImage,
  startImage,
  finishImage,
  removeImage,
  genDir,
  prepareGen,
  collectGen,
  resolveFile,
  projectDir,
  buildPrompt,
  flush,
  ROOT,
};
