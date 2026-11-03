'use strict';

// Pièces jointes aux prompts. Écrites sur disque plutôt que gardées en base64 :
// Codex prend les images par chemin (`--image`), et l'outil Read des trois CLIs
// lit un fichier — image ou texte — dès qu'on lui donne son chemin.
//
// Le texte (markdown, JSON) n'est pas recopié dans le prompt. Au moment du turn,
// une copie est déposée dans le projet pour que l'agent l'ouvre avec Read.
// Voir `appendAttachedFiles`.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

const MAX_PER_IMAGE = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PER_TURN = 5;

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

// L'extension du nom d'origine décide : les navigateurs ne s'accordent pas sur le
// type d'un .md (vide, text/markdown, text/plain, ou application/octet-stream).
const TEXT_EXT = {
  '.md': 'md',
  '.markdown': 'md',
  '.json': 'json',
};

const ACCEPTED = 'png, jpeg, webp, gif, md, json';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/**
 * @param {string} name
 * @param {string} mime
 * @returns {{kind: 'image'|'text', ext: string}}
 */
function classify(name, mime) {
  const fromName = TEXT_EXT[path.extname(String(name || '')).toLowerCase()];
  if (fromName) {
    // Un .json qui se déclare image n'est pas du texte : on refuse plutôt que d'afficher
    // du binaire à l'agent. Le type vide ou générique, lui, est celui d'un vrai markdown.
    if (mime.startsWith('image/') || mime === 'image/svg+xml') {
      throw new Error(`Format non pris en charge : ${name || mime} (${ACCEPTED})`);
    }
    if (
      mime &&
      !mime.startsWith('text/') &&
      mime !== 'application/json' &&
      mime !== 'application/octet-stream'
    ) {
      throw new Error(`Format non pris en charge : ${mime} (${ACCEPTED})`);
    }
    return { kind: 'text', ext: fromName };
  }

  const ext = EXT[mime];
  if (!ext) throw new Error(`Format non pris en charge : ${mime || name || 'inconnu'} (${ACCEPTED})`);
  return { kind: 'image', ext };
}

/** Le nom affiché garde son extension, sinon l'interface ne sait plus que c'est un texte. */
function displayName(name, ext) {
  const raw = String(name || '')
    .replace(/[\r\n\0]/g, ' ')
    .trim();
  const base = raw || (ext === 'md' || ext === 'json' ? `fichier.${ext}` : `image.${ext}`);
  if (base.length <= 80) return base;
  const suffix = path.extname(base) || `.${ext}`;
  return base.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
}

/**
 * UTF-8, sans octet nul. Un binaire renommé en .json ne doit pas entrer dans le prompt.
 * @param {Buffer} buffer
 * @param {string} name
 */
function assertUtf8Text(buffer, name) {
  if (buffer.includes(0)) throw new Error(`${name} : ce n'est pas un fichier texte`);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${name} : encodage non pris en charge (UTF-8 attendu)`);
  }
}

/**
 * @param {string} convId
 * @param {Array<{name?: string, dataUrl: string}>} images
 * @returns {Array<{path: string, url: string, name: string, bytes: number, kind: 'image'|'text'}>}
 */
function save(convId, images) {
  if (!Array.isArray(images) || !images.length) return [];
  if (images.length > MAX_PER_TURN) {
    throw new Error(`${MAX_PER_TURN} pièces jointes maximum par message`);
  }
  if (!/^[a-f0-9-]{36}$/i.test(convId)) throw new Error('Conversation invalide');

  const dir = path.join(UPLOAD_DIR, convId);
  fs.mkdirSync(dir, { recursive: true });

  const saved = [];
  try {
    for (const image of images) {
      // `charset` arrive parfois entre le type et `base64`. Un type vide aussi :
      // certains navigateurs écrivent `data:;base64` ou `data:application/octet-stream`.
      const match = /^data:([^;,]*)(?:;charset=[^;,]+)?;base64,(.*)$/is.exec(image.dataUrl || '');
      if (!match) throw new Error('Fichier illisible (data URL attendue)');

      const mime = match[1].toLowerCase();
      const { kind, ext } = classify(image.name, mime);

      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length) throw new Error(kind === 'text' ? 'Fichier vide' : 'Image vide');
      const cap = kind === 'text' ? MAX_TEXT_BYTES : MAX_PER_IMAGE;
      if (buffer.length > cap) {
        const maxMo = kind === 'text' ? 2 : 10;
        const label = kind === 'text' ? 'Fichier' : 'Image';
        throw new Error(
          `${label} trop lourd (${Math.round(buffer.length / 1e6)} Mo, ${maxMo} Mo maximum)`
        );
      }
      if (kind === 'text') assertUtf8Text(buffer, displayName(image.name, ext));

      // Nom généré : le nom d'origine ne sert que d'affichage, jamais de chemin.
      const file = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      const full = path.join(dir, file);
      fs.writeFileSync(full, buffer);

      saved.push({
        path: full,
        url: `/uploads/${convId}/${file}`,
        name: displayName(image.name, ext),
        bytes: buffer.length,
        kind,
      });
    }
  } catch (err) {
    // Un fichier refusé au milieu du lot ne doit pas laisser les précédents orphelins :
    // l'appelant n'a pas leurs chemins, personne ne les effacera.
    for (const item of saved) fs.rmSync(item.path, { force: true });
    throw err;
  }
  return saved;
}

/**
 * Images produites par un outil — les captures d'écran d'un serveur MCP de navigateur.
 *
 * Rangées avec les images jointes plutôt qu'ailleurs : même portée (une conversation),
 * même service HTTP, et `removeConversation` les emporte déjà. Ce qui change, c'est le
 * régime d'erreur. Une image jointe qui échoue doit faire échouer l'envoi, l'utilisateur
 * est là pour le lire. Une capture qui échoue ne doit **jamais** interrompre un turn en
 * cours : on la laisse tomber et on garde le texte du résultat.
 *
 * Pas de plafond par turn non plus : une session de QA visuel prend légitimement dix
 * captures d'affilée.
 *
 * @param {string} convId
 * @param {Array<{mime: string, base64: string}>} images
 * @returns {Array<{url: string, name: string, bytes: number}>}
 */
function saveFromTool(convId, images) {
  if (!Array.isArray(images) || !images.length) return [];
  if (!/^[a-f0-9-]{36}$/i.test(convId)) return [];

  const dir = path.join(UPLOAD_DIR, convId);
  const saved = [];
  for (const image of images) {
    try {
      const ext = EXT[String(image.mime || '').toLowerCase()];
      if (!ext) continue;
      const buffer = Buffer.from(image.base64, 'base64');
      if (!buffer.length || buffer.length > MAX_PER_IMAGE) continue;

      fs.mkdirSync(dir, { recursive: true });
      const file = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
      fs.writeFileSync(path.join(dir, file), buffer);
      saved.push({
        url: `/uploads/${convId}/${file}`,
        name: `capture.${ext}`,
        bytes: buffer.length,
      });
    } catch (err) {
      console.error(`image d'outil non enregistrée : ${err.message}`);
    }
  }
  return saved;
}

/** Supprime des fichiers précis, quand un message en attente est retiré ou modifié. */
function removeFiles(paths) {
  const root = path.resolve(UPLOAD_DIR);
  for (const p of paths || []) {
    // On n'efface que sous le dossier d'uploads, jamais ailleurs.
    if (typeof p !== 'string') continue;
    const candidate = path.resolve(p);
    const relative = path.relative(root, candidate);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    fs.rmSync(candidate, { force: true });
  }
}

/** Supprime le dossier d'images d'une conversation supprimée. */
function removeConversation(convId) {
  if (!/^[a-f0-9-]{36}$/i.test(convId)) return;
  fs.rmSync(path.join(UPLOAD_DIR, convId), { recursive: true, force: true });
}

module.exports = {
  save,
  saveFromTool,
  removeFiles,
  removeConversation,
  UPLOAD_DIR,
  MAX_PER_TURN,
  MAX_PER_IMAGE,
  MAX_TEXT_BYTES,
};
