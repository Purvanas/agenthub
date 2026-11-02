'use strict';

// Quels fournisseurs sont réellement utilisables, et sous quel compte.
//
// Ce n'est pas un test d'existence de fichier. Un fichier d'authentification peut très
// bien contenir un jeton révoqué : c'est exactement ce qui faisait passer un compte mort
// pour connecté pendant que chaque turn échouait en 401. On interroge donc les CLIs.
//
// Trois états, parce qu'ils appellent trois réponses différentes dans l'interface :
//
//   absent      le binaire n'est pas installé — il n'y a rien à proposer, et surtout pas
//               d'erreur à afficher : personne n'est obligé d'avoir les trois abonnements
//   offline     installé mais sans session — proposer de se connecter
//   online      utilisable, et on sait sous quel compte
//
// Aucune valeur de jeton n'est lue nulle part. Pour Grok, seules les clés du fichier
// d'authentification sont regardées, jamais leur contenu.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { binFor } = require('./runner');

const TTL_MS = 30_000;

const cache = new Map(); // provider -> { at, data }
const inFlight = new Map(); // provider -> Promise

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || '',
        // ENOENT : le binaire n'existe pas. À distinguer d'un binaire qui répond mal.
        missing: Boolean(err && err.code === 'ENOENT'),
        err,
      });
    });
  });
}

const ABSENT = (bin) => ({
  state: 'absent',
  // Le nom de la commande, pas son chemin : « grok n'est pas installé » se lit mieux
  // que « /home/…/.grok/bin/grok n'est pas installé ».
  label: `${path.basename(bin)} n'est pas installé`,
});

/** `claude auth status` répond en JSON, avec l'adresse du compte. ~420 ms. */
async function detectClaude() {
  const bin = binFor('claude');
  const { stdout, missing } = await run(bin, ['auth', 'status'], 20_000);
  if (missing) return ABSENT(bin);

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    // Sortie inattendue : on ne devine pas. Mieux vaut dire qu'on ne sait pas que
    // d'affirmer une déconnexion et faire disparaître un fournisseur qui marche.
    return { state: 'unknown', label: 'État de session illisible' };
  }

  if (!info.loggedIn) return { state: 'offline', label: 'Non connecté' };

  const parts = [info.orgName, info.subscriptionType].filter(Boolean);
  return {
    state: 'online',
    account: info.email || info.orgName || null,
    label: parts.join(' · ') || info.authMethod || null,
    method: info.authMethod || null,
  };
}

/**
 * `codex login status` répond en texte et sort toujours en 0, connecté ou non : c'est le
 * texte qui fait foi, pas le code de retour. ~75 ms.
 */
async function detectCodex() {
  const bin = binFor('codex');
  const { stdout, stderr, missing } = await run(bin, ['login', 'status'], 20_000);
  if (missing) return ABSENT(bin);

  const text = `${stdout}\n${stderr}`;
  if (/not logged in/i.test(text)) return { state: 'offline', label: 'Non connecté' };

  const how = /logged in(?:\s+using\s+(.+?))?\s*$/im.exec(text);
  if (how) {
    return {
      state: 'online',
      account: how[1] ? how[1].trim() : null,
      label: how[1] ? `via ${how[1].trim()}` : null,
      method: how[1] ? how[1].trim() : null,
    };
  }
  return { state: 'unknown', label: 'État de session illisible' };
}

/**
 * Grok n'a pas de commande d'état : ni `login status`, ni indicateur exploitable dans
 * `grok inspect`. On lit donc son fichier d'authentification — uniquement ses clés, qui
 * ont la forme `https://auth.x.ai::<identifiant>`. Les valeurs sont les jetons et ne sont
 * jamais lues.
 */
async function detectGrok() {
  const bin = binFor('grok');
  if (!fs.existsSync(bin)) {
    // Chemin absolu par défaut : PM2 ne lit pas le .bashrc où l'installeur pose le PATH.
    const { missing } = await run(bin, ['--version'], 15_000);
    if (missing) return ABSENT(bin);
  }

  const file = path.join(os.homedir(), '.grok', 'auth.json');
  let keys;
  try {
    keys = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { state: 'offline', label: 'Non connecté' };
  }
  if (!keys.length) return { state: 'offline', label: 'Non connecté' };

  // « https://auth.x.ai::0123abcd-… » : l'émetteur, puis l'identifiant de compte. Grok
  // n'expose pas d'adresse e-mail, on montre donc l'émetteur et un identifiant abrégé.
  const [issuer, id] = String(keys[0]).split('::');
  const host = (() => {
    try {
      return new URL(issuer).host;
    } catch {
      return issuer;
    }
  })();

  return {
    state: 'online',
    account: host || null,
    label: id ? `compte ${id.slice(0, 8)}` : null,
    method: host || null,
  };
}

const DETECT = { claude: detectClaude, codex: detectCodex, grok: detectGrok };

async function detect(provider) {
  const fn = DETECT[provider];
  if (!fn) return { state: 'absent', label: 'Fournisseur inconnu' };
  try {
    return await fn();
  } catch (err) {
    return { state: 'unknown', label: err.message };
  }
}

/**
 * État d'un fournisseur, mis en cache : ces commandes sont appelées à chaque chargement
 * de page et ne changent qu'au moment d'une connexion ou d'une déconnexion, qui invalident
 * explicitement le cache.
 */
async function get(provider) {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  if (inFlight.has(provider)) return inFlight.get(provider);

  const promise = detect(provider).then((data) => {
    cache.set(provider, { at: Date.now(), data });
    inFlight.delete(provider);
    return data;
  });
  inFlight.set(provider, promise);
  return promise;
}

/** Tous les fournisseurs, interrogés en parallèle. */
async function all(providers) {
  const list = [...providers];
  const results = await Promise.all(list.map((p) => get(p)));
  return Object.fromEntries(list.map((p, i) => [p, results[i]]));
}

/** À appeler après une connexion ou une déconnexion : l'état vient de changer. */
function invalidate(provider) {
  if (provider) cache.delete(provider);
  else cache.clear();
}

/** Un fournisseur utilisable est un fournisseur avec lequel on peut lancer un turn. */
function isUsable(status) {
  return Boolean(status && (status.state === 'online' || status.state === 'unknown'));
}

module.exports = { get, all, invalidate, isUsable, detect };
