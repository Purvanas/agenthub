'use strict';

// Turns en vol : ce qu'il faut savoir pour reprendre un turn après un redémarrage.
//
// Le flux d'un CLI passait par un tuyau, qui meurt avec le processus qui le lit. Un
// `pm2 restart` perdait donc le turn en cours. Il passe maintenant par un **fichier**, qui
// ne se ferme pas quand son lecteur disparaît — et ce module retient où on en était.
//
// `offset` est la clé de la reprise : c'est la position jusqu'à laquelle le flux a été
// *traité*, pas seulement lu. En repartant de là, rien n'est rejoué deux fois et rien n'est
// perdu entre le dernier relevé et l'arrêt.
//
// Le fichier est réécrit à chaque avancée, en atomique. C'est une écriture de quelques
// centaines d'octets toutes les deux cents millisecondes pendant un turn : négligeable à côté
// du journal des items, qui grossit du contenu réel.

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.AGENTHUB_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'inflight.json');
const TURNS_DIR = path.join(DATA_DIR, 'turns');

fs.mkdirSync(TURNS_DIR, { recursive: true });

/** Un fichier par conversation : elle ne peut avoir qu'un turn à la fois. */
function outPath(convId) {
  return path.join(TURNS_DIR, `${convId}.jsonl`);
}

function errPath(convId) {
  return path.join(TURNS_DIR, `${convId}.err`);
}

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, FILE);
}

/** Ouvre un turn : à appeler juste après le spawn, avec le pid réel. */
function open({ convId, pid, provider }) {
  const map = readAll();
  map[convId] = {
    convId,
    pid,
    provider,
    out: outPath(convId),
    err: errPath(convId),
    offset: 0,
    startedAt: new Date().toISOString(),
    // Dernier signe de vie du flux. Confondu avec `startedAt` au départ, ce qui est exact :
    // un turn qui n'a rien écrit depuis son lancement est silencieux depuis son lancement.
    lastAt: new Date().toISOString(),
  };
  writeAll(map);
  return map[convId];
}

/**
 * Avance la position traitée.
 *
 * Ne réécrit que si elle a bougé : le suivi interroge le fichier plusieurs fois par seconde,
 * et la plupart du temps il n'y a rien de nouveau.
 *
 * C'est aussi le seul endroit qui sait qu'un turn donne encore signe de vie : une position qui
 * avance veut dire que le CLI a écrit. `lastAt` est donc daté ici, et nulle part ailleurs —
 * gratuitement, puisque le fichier était de toute façon réécrit.
 */
function advance(convId, offset) {
  const map = readAll();
  const found = map[convId];
  if (!found || found.offset === offset) return null;
  found.offset = offset;
  found.lastAt = new Date().toISOString();
  writeAll(map);
  return found;
}

/** Ferme un turn terminé, et efface ses fichiers de flux. */
function close(convId) {
  const map = readAll();
  if (map[convId]) {
    delete map[convId];
    writeAll(map);
  }
  // Le contenu utile est déjà dans le journal des items : garder le flux brut ne servirait
  // qu'à faire grossir `data/`.
  fs.rmSync(outPath(convId), { force: true });
  fs.rmSync(errPath(convId), { force: true });
}

/** Turns qui étaient en vol au dernier arrêt. */
function list() {
  return Object.values(readAll());
}

/**
 * Ce processus tourne-t-il encore ?
 *
 * `kill(pid, 0)` ne tue rien : il vérifie l'existence et le droit de signaler. C'est la
 * façon standard, et elle ne dépend pas de `/proc`.
 */
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM : le processus existe mais appartient à quelqu'un d'autre. Il vit.
    return err && err.code === 'EPERM';
  }
}

module.exports = { open, advance, close, list, alive, outPath, errPath, FILE, TURNS_DIR };
