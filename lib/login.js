'use strict';

// Connexion et déconnexion d'un fournisseur, depuis l'interface.
//
// Pas de terminal web. Les trois CLIs savent s'authentifier sans TTY, et ouvrir un shell
// distant dans une application qui lance déjà des agents en autonomie totale doublerait
// la surface d'attaque sans rien apporter.
//
// Comportements mesurés le 01/08/2026, dans un HOME isolé et sans TTY :
//
//   claude auth login           stdout   l'URL, puis attend le code sur stdin
//   codex login --device-auth   stdout   l'URL et le code, puis interroge de lui-même
//   grok  login --device-auth   stderr   l'URL et le code, puis interroge de lui-même
//
// D'où deux formes seulement : « recopier le code depuis le navigateur » chez Claude,
// « confirmer le code affiché » chez les deux autres.

const { spawn, execFile } = require('child_process');

const { binFor, killTree } = require('./runner');

// Codex annonce un code valable 15 minutes ; on s'aligne, et on n'attend pas au-delà.
const EXPIRY_MS = 15 * 60_000;

const FLOWS = {
  claude: { args: ['auth', 'login'], needsCode: true },
  codex: { args: ['login', '--device-auth'], needsCode: false },
  grok: { args: ['login', '--device-auth'], needsCode: false },
};

const LOGOUT = {
  claude: ['auth', 'logout'],
  codex: ['logout'],
  grok: ['logout'],
};

/** @type {Map<string, object>} un flux de connexion en cours par fournisseur */
const flows = new Map();

/**
 * Les CLIs colorent leur sortie. `NO_COLOR` devrait suffire, mais Codex colore quand
 * même : on retire les séquences d'échappement. L'octet d'échappement est optionnel, il
 * disparaît selon la façon dont la sortie a été capturée.
 */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/?\[[0-9;]*[a-zA-Z]/g, '');
}

function findUrl(text) {
  const m = /https?:\/\/[^\s'"<>]+/.exec(text);
  return m ? m[0].replace(/[.,)]+$/, '') : null;
}

/**
 * Le code à confirmer. Grok le porte dans l'URL (`user_code=…`), Codex l'affiche seul
 * sur sa ligne. Claude n'en affiche aucun : c'est le navigateur qui en donne un, que
 * l'utilisateur recopie.
 */
function findCode(text) {
  const inUrl = /[?&]user_code=([A-Z0-9-]{6,})/i.exec(text);
  if (inUrl) return inUrl[1].toUpperCase();
  const alone = /^\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,7})\s*$/m.exec(text);
  return alone ? alone[1].toUpperCase() : null;
}

function publicView(flow) {
  if (!flow) return { state: 'idle' };
  return {
    state: flow.state,
    url: flow.url || null,
    code: flow.code || null,
    needsCode: Boolean(flow.needsCode),
    // `codeSent` distingue « on attend que tu colles le code » de « on attend le serveur ».
    codeSent: Boolean(flow.codeSent),
    error: flow.error || null,
    expiresAt: flow.expiresAt || null,
  };
}

function status(provider) {
  return publicView(flows.get(provider));
}

/**
 * Démarre une connexion. Un flux déjà en cours pour ce fournisseur est annulé : deux
 * codes en vol pour le même compte n'aideraient personne.
 *
 * @param {(provider: string, view: object) => void} onChange notifié à chaque étape
 */
function start(provider, onChange) {
  const flow = FLOWS[provider];
  if (!flow) throw new Error(`Provider inconnu : ${provider}`);

  cancel(provider);

  const bin = binFor(provider);
  const child = spawn(bin, flow.args, {
    detached: true, // pour pouvoir interrompre tout le groupe
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const entry = {
    provider,
    child,
    state: 'starting',
    needsCode: flow.needsCode,
    text: '',
    url: null,
    code: null,
    codeSent: false,
    error: null,
    expiresAt: Date.now() + EXPIRY_MS,
  };
  flows.set(provider, entry);

  const notify = () => onChange && onChange(provider, publicView(entry));

  const absorb = (chunk) => {
    entry.text = `${entry.text}${plain(chunk)}`.slice(-8000);
    const url = findUrl(entry.text);
    const code = findCode(entry.text);
    let changed = false;
    if (url && url !== entry.url) {
      entry.url = url;
      changed = true;
    }
    if (code && code !== entry.code) {
      entry.code = code;
      changed = true;
    }
    if (entry.url && entry.state === 'starting') {
      entry.state = 'waiting';
      changed = true;
    }
    if (changed) notify();
  };

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  // Les deux flux, parce que Grok écrit sur stderr et les deux autres sur stdout.
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  child.stdin.on('error', () => {});

  child.on('error', (err) => {
    entry.state = 'failed';
    entry.error =
      err.code === 'ENOENT' ? `${bin} n'est pas installé` : err.message;
    notify();
  });

  child.on('close', (code) => {
    clearTimeout(entry.timer);
    if (entry.state === 'cancelled') return notify();
    if (code === 0) {
      entry.state = 'done';
    } else {
      entry.state = 'failed';
      // La dernière ligne non vide est en général la raison ; sinon on le dit franchement.
      const lines = entry.text.trim().split('\n').filter((l) => l.trim());
      entry.error = lines.length
        ? lines[lines.length - 1].trim().slice(0, 300)
        : `La connexion s'est arrêtée avec le code ${code}`;
    }
    notify();
  });

  entry.timer = setTimeout(() => {
    if (entry.state === 'done' || entry.state === 'failed') return;
    entry.error = 'Code expiré : relance la connexion.';
    cancel(provider, 'failed');
    notify();
  }, EXPIRY_MS);
  if (entry.timer.unref) entry.timer.unref();

  notify();
  return publicView(entry);
}

/** Chez Claude, le code vient du navigateur : on l'écrit sur l'entrée du process. */
function submitCode(provider, code) {
  const entry = flows.get(provider);
  if (!entry || entry.state !== 'waiting') throw new Error('Aucune connexion en attente');
  if (!entry.needsCode) throw new Error("Ce fournisseur n'attend pas de code");

  const clean = String(code || '').trim();
  if (!clean) throw new Error('Code vide');

  entry.child.stdin.write(`${clean}\n`);
  entry.codeSent = true;
  return publicView(entry);
}

function cancel(provider, nextState) {
  const entry = flows.get(provider);
  if (!entry) return false;
  clearTimeout(entry.timer);
  if (entry.state === 'starting' || entry.state === 'waiting') {
    entry.state = nextState || 'cancelled';
    try {
      killTree(entry.child);
    } catch {
      /* déjà mort */
    }
  }
  return true;
}

/** Oublie un flux terminé, pour que l'interface reparte d'un état propre. */
function clear(provider) {
  cancel(provider);
  flows.delete(provider);
}

function logout(provider) {
  const args = LOGOUT[provider];
  if (!args) return Promise.reject(new Error(`Provider inconnu : ${provider}`));
  const bin = binFor(provider);
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      if (!err) return resolve(plain(stdout || stderr).trim());
      reject(new Error(plain(stderr || err.message).trim().slice(0, 300)));
    });
  });
}

module.exports = { start, submitCode, cancel, clear, status, logout, FLOWS };
