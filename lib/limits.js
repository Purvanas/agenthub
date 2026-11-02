'use strict';

// Limites d'usage des abonnements, par provider. Aucune API ne les expose :
//
// - Claude : `claude --print '/usage'` renvoie les pourcentages en texte, coûte
//   0 $ et répond en ~350 ms.
// - Codex : seul le `/status` de son TUI les affiche. On pilote donc une session
//   tmux jetable pour lire l'écran (~12 s, aucun token consommé), avec un cache
//   plus long en conséquence.
//
// Sortie normalisée : `percent` est toujours un pourcentage CONSOMMÉ, alors que
// Codex affiche du « % restant ». Chaque compteur porte aussi `resetsAt`, la même
// échéance en ISO : « Aug 6, 3:49pm » ne dit pas s'il reste dix minutes ou six
// heures, et c'est cette durée-là qu'on veut lire.

const { execFile } = require('child_process');

const CLAUDE_BIN = process.env.AGENTHUB_CLAUDE_BIN || 'claude';
const CODEX_BIN = process.env.AGENTHUB_CODEX_BIN || 'codex';
const WORK_DIR = __dirname;

const TTL = { claude: 60_000, codex: 300_000 };

const cache = new Map(); // provider -> { at, data }
const inFlight = new Map(); // provider -> Promise

function run(bin, args, timeout) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      resolve({ stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// Décalage d'un fuseau à un instant donné : le seul moyen fiable en Node sans
// dépendance, puisque `Date` ne sait construire qu'en local ou en UTC.
function zoneOffset(ts, zone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts));
    const f = {};
    for (const p of parts) f[p.type] = p.value;
    // `hour12: false` produit « 24 » à minuit dans certains environnements.
    const hour = Number(f.hour) % 24;
    const asUtc = Date.UTC(+f.year, +f.month - 1, +f.day, hour, +f.minute, +f.second);
    return asUtc - ts;
  } catch {
    return null;
  }
}

// Heure murale d'un fuseau → instant absolu. Deux passes : la première donne le
// décalage approché, la seconde le corrige si on a atterri de l'autre côté d'un
// changement d'heure.
function fromZoned({ year, month, day, hour, minute }, zone) {
  const wall = Date.UTC(year, month, day, hour, minute);
  const first = zoneOffset(wall, zone);
  if (first === null) return null;
  let ts = wall - first;
  const second = zoneOffset(ts, zone);
  if (second !== null && second !== first) ts = wall - second;
  return ts;
}

// Ni Claude ni Codex n'écrivent l'année. On prend celle qui tombe le plus près
// de maintenant : le 31 décembre, « resets Jan 2 » parle de l'année suivante.
function nearestYear(now, build) {
  const base = new Date(now).getUTCFullYear();
  let best = null;
  for (const year of [base - 1, base, base + 1]) {
    const ts = build(year);
    if (ts === null || Number.isNaN(ts)) continue;
    if (best === null || Math.abs(ts - now) < Math.abs(best - now)) best = ts;
  }
  return best;
}

const CLAUDE_RESET = /^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{1,2}):(\d{2})\s*([ap]m)?\s*(?:\(([^)]+)\))?$/i;
const CODEX_RESET = /^(\d{1,2}):(\d{2})\s+on\s+(\d{1,2})\s+([A-Za-z]{3,})$/i;

/**
 * « Aug 6, 3:49pm (Europe/Paris) » ou « 14:01 on 31 Jul » → instant ISO.
 * Renvoie null si le format n'est pas reconnu : mieux vaut garder le texte brut
 * qu'afficher une durée fausse.
 */
function parseResetAt(text, now = Date.now(), fallbackZone) {
  if (!text) return null;
  const zoneOf = (z) => (z && zoneOffset(now, z) !== null ? z : fallbackZone || localZone());

  let month, day, hour, minute, zone;
  const claude = CLAUDE_RESET.exec(text.trim());
  const codex = claude ? null : CODEX_RESET.exec(text.trim());

  if (claude) {
    month = MONTHS[claude[1].slice(0, 3).toLowerCase()];
    day = Number(claude[2]);
    hour = Number(claude[3]);
    minute = Number(claude[4]);
    const ampm = (claude[5] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    zone = zoneOf(claude[6]);
  } else if (codex) {
    hour = Number(codex[1]);
    minute = Number(codex[2]);
    day = Number(codex[3]);
    month = MONTHS[codex[4].slice(0, 3).toLowerCase()];
    zone = zoneOf(null);
  } else {
    return null;
  }

  if (month === undefined || day < 1 || day > 31 || hour > 23 || minute > 59) return null;

  const ts = nearestYear(now, (year) => fromZoned({ year, month, day, hour, minute }, zone));
  return ts === null ? null : new Date(ts).toISOString();
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

// « Current session: 29% used · resets Jul 31, 12:59pm (UTC) »
function parseClaude(text) {
  const buckets = [];
  const re = /^\s*(Current [^:]+):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const resets = m[3] ? m[3].trim() : null;
    buckets.push({
      label: m[1]
        .replace('Current session', 'Fenêtre de 5 h')
        .replace('Current week (all models)', 'Semaine · tous modèles')
        .replace('Current week', 'Semaine')
        .trim(),
      percent: Number(m[2]),
      resets,
      resetsAt: parseResetAt(resets),
    });
  }
  return buckets;
}

// « Weekly limit:   [░░░░] 0% left (resets 07:01 on 5 Aug) »
function parseCodex(text) {
  const buckets = [];
  const re = /^[\s│|]*(.+?limit):\s*\[[^\]]*\]\s*(\d+(?:\.\d+)?)%\s*left\s*\(resets\s*([^)]+)\)/gim;
  let m;
  while ((m = re.exec(text)) !== null) {
    const resets = m[3].trim();
    buckets.push({
      label: m[1].replace(/^Weekly limit$/i, 'Semaine').replace(/\s*Weekly limit$/i, ' · semaine'),
      percent: Math.max(0, 100 - Number(m[2])), // Codex donne le restant
      resets,
      resetsAt: parseResetAt(resets),
    });
  }
  const account = /^[\s│|]*Account:\s*(.+?)\s*[│|]?\s*$/im.exec(text);
  return { buckets, account: account ? account[1].trim() : null };
}

async function fetchClaude() {
  const { stdout, stderr, err } = await run(CLAUDE_BIN, ['--print', '/usage'], 30_000);
  if (err && !stdout) {
    return { buckets: [], error: (stderr || err.message).trim().slice(0, 300) };
  }
  const buckets = parseClaude(stdout);
  return buckets.length
    ? { buckets }
    : { buckets: [], error: 'Format de /usage non reconnu' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Quand une version sort, le TUI de Codex s'arrête sur un menu avant de démarrer :
//
//   › 1. Update now (runs `npm install -g @openai/codex`)
//     2. Skip
//     3. Skip until next version
//     Press enter to continue
//
// Personne ne le voit — la session tmux est jetable — et la sidebar affichait donc
// « Quotas indisponibles » jusqu'à ce qu'on mette Codex à jour à la main.
//
// L'entrée sélectionnée par défaut lance `npm install -g`. Appuyer sur Entrée à
// l'aveugle installerait donc une version globale dans le dos de l'utilisateur : on
// ne valide qu'après avoir relu à l'écran que le curseur est bien sur « Skip ». Si le
// menu est reformulé, on ne reconnaît rien et on ne touche à rien.
const MENU_OPTION = /^\s*([›>❯▸])?\s*(\d+)\.\s+(.*\S)\s*$/;

function updatePrompt(screen) {
  if (!/Update available!/i.test(screen) || !/Press enter to continue/i.test(screen)) return null;

  const options = [];
  let selected = null;
  for (const line of screen.split('\n')) {
    const m = MENU_OPTION.exec(line);
    if (!m) continue;
    const option = { n: Number(m[2]), label: m[3] };
    options.push(option);
    if (m[1]) selected = option.n;
  }

  const skip = options.find((o) => /^Skip$/i.test(o.label));
  const update = options.find((o) => /^Update now\b/i.test(o.label));
  if (!skip || !update) return null;
  return { selected, skip: skip.n, update: update.n };
}

// Déplace le curseur jusqu'à « Skip », en relisant l'écran après chaque touche, puis
// valide. Renvoie false sans jamais appuyer sur Entrée si la vérification échoue.
async function dismissUpdate(t, session, first) {
  let state = first;
  for (let i = 0; i < 5 && state.selected !== state.skip; i++) {
    await t('send-keys', '-t', session, state.selected > state.skip ? 'Up' : 'Down');
    await sleep(400);
    const { stdout } = await t('capture-pane', '-p', '-J', '-t', session);
    const again = updatePrompt(stdout);
    if (!again) return false; // l'écran a changé sous nos pieds
    state = again;
  }
  if (state.selected !== state.skip) return false;
  await t('send-keys', '-t', session, 'Enter');
  return true;
}

// Le TUI de Codex n'a pas d'équivalent non-interactif : on lit son écran. Les
// délais de démarrage varient beaucoup (initialisation des serveurs MCP), donc on
// scrute l'écran jusqu'à obtenir les limites au lieu d'attendre une durée fixe.
async function fetchCodex() {
  const session = `ahlimits${process.pid}`;
  const t = (...args) => run('tmux', args, 20_000);

  await t('kill-session', '-t', session);
  const started = await t(
    'new-session', '-d', '-s', session, '-x', '200', '-y', '55',
    `cd ${WORK_DIR} && ${CODEX_BIN}`
  );
  if (started.err) {
    return { buckets: [], error: `tmux indisponible : ${started.err.message}` };
  }

  try {
    const deadline = Date.now() + 60_000;
    let asked = false;
    let blocked = null;
    while (Date.now() < deadline) {
      await sleep(1500);
      const { stdout } = await t('capture-pane', '-p', '-J', '-t', session);

      const update = asked ? null : updatePrompt(stdout);
      if (update) {
        if (!(await dismissUpdate(t, session, update))) {
          blocked = 'Écran de mise à jour de Codex non reconnu, quotas non relevés';
          break;
        }
        continue;
      }

      if (!asked) {
        if (/OpenAI Codex/i.test(stdout)) {
          await t('send-keys', '-t', session, '-l', '/status');
          await sleep(800);
          await t('send-keys', '-t', session, 'Enter');
          asked = true;
        }
        continue;
      }

      const parsed = parseCodex(stdout);
      if (parsed.buckets.length) return parsed;
    }
    return {
      buckets: [],
      error:
        blocked ||
        (asked ? 'Délai dépassé en lisant /status de Codex' : 'Le TUI Codex n\'a pas démarré'),
    };
  } finally {
    await t('kill-session', '-t', session);
  }
}

// Grok Build n'expose aucune commande de quota : ni sous-commande dédiée, ni
// équivalent du /status de Codex. On le dit au lieu d'inventer un chiffre.
async function fetchGrok() {
  return { buckets: [] };
}

const FETCHERS = { claude: fetchClaude, codex: fetchCodex, grok: fetchGrok };

/**
 * Renvoie les limites du provider. Si rien n'est en cache, lance la collecte en
 * arrière-plan et répond `pending` : le TUI de Codex met une dizaine de secondes,
 * on ne bloque pas l'affichage de la sidebar pour autant.
 */
function get(provider, force = false) {
  const fetcher = FETCHERS[provider];
  if (!fetcher) return { provider, buckets: [], unsupported: true };

  const hit = cache.get(provider);
  // Un échec n'est gardé que 30 s : sinon un TUI lent au démarrage bloquerait
  // l'affichage pendant toute la durée du cache normal.
  const ttl = hit && hit.data.error ? 30_000 : TTL[provider] || 60_000;
  const fresh = hit && Date.now() - hit.at < ttl;
  if (fresh && !force) return { provider, ...hit.data };

  if (!inFlight.has(provider)) {
    inFlight.set(
      provider,
      fetcher()
        .then((data) => {
          cache.set(provider, { at: Date.now(), data: { ...data, fetchedAt: new Date().toISOString() } });
          return data;
        })
        .catch((err) => {
          cache.set(provider, { at: Date.now(), data: { buckets: [], error: err.message } });
        })
        .finally(() => inFlight.delete(provider))
    );
  }

  // On sert la valeur périmée s'il y en a une, plutôt que rien.
  if (hit) return { provider, ...hit.data, stale: true };
  return { provider, buckets: [], pending: true };
}

module.exports = { get, parseClaude, parseCodex, parseResetAt, updatePrompt, dismissUpdate };
