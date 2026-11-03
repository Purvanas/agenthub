'use strict';

// Fuseau du processus, posé avant toute manipulation de date.
//
// Le serveur tourne en UTC, mais un déclencheur « chaque jour à 7 h » doit partir à 7 h
// chez l'utilisateur, pas à 9 h. Les échéances sont calculées en heure murale locale — y
// compris à travers un changement d'heure — donc le processus doit connaître le bon
// fuseau. Les crons système de la machine restent en UTC, ce sont des scripts d'ops.
process.env.TZ = process.env.AGENTHUB_TZ || 'Europe/Paris';

const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');

const store = require('./lib/store');
const projects = require('./lib/projects');
const usage = require('./lib/usage');
const limits = require('./lib/limits');
const uploads = require('./lib/uploads');
const checkpoints = require('./lib/checkpoints');
// `gitRepo` et non `git` : le nom `git` est déjà celui des helpers d'exécution dans les
// modules qui lancent la commande, et la confusion coûterait cher ici.
const gitRepo = require('./lib/git');
const handoff = require('./lib/handoff');
const contextActions = require('./lib/context-actions');
const triggers = require('./lib/triggers');
const hooks = require('./lib/hooks');
const prompts = require('./lib/prompts');
const runs = require('./lib/runs');
const browserMcp = require('./lib/browser');
const remoteBrowser = require('./lib/remote-browser');
const authRequests = require('./lib/auth-requests');
const asks = require('./lib/asks');
const worktrees = require('./lib/worktrees');
const notes = require('./lib/notes');
const plans = require('./lib/plans');
const memory = require('./lib/memory');
const rules = require('./lib/rules');
const panel = require('./lib/panel');
const mcpServer = require('./lib/mcp-server');
const presence = require('./lib/presence');
const { listenWithRetry, retryable: listenRetryable } = require('./lib/listen');
const watchBrowser = require('./lib/watch-browser');
const team = require('./lib/team');
const googleOauth = require('./lib/google-oauth');
const report = require('./lib/report');
const mail = require('./lib/mail');
const secrets = require('./lib/secrets');
const skills = require('./lib/skills');
const titles = require('./lib/title');
const goals = require('./lib/goal');
const atelier = require('./lib/atelier');
const planned = require('./lib/planned');
const sessions = require('./lib/sessions');
const accounts = require('./lib/accounts');
const login = require('./lib/login');
const gallery = require('./lib/gallery');
const { SearchService } = require('./lib/search-service');
const { registerConnectionsRoutes } = require('./lib/http/connections');
const { registerFolderRoutes } = require('./lib/http/folders');
const { registerPlanRoutes, registerProjectKnowledgeRoutes } = require('./lib/http/project-assets');
const { createSettingsChecks, registerSettingsRoutes } = require('./lib/http/settings');
const searchService = new SearchService({
  fileOf: (id) => store.itemsFile(id), indexDir: path.join(store.DATA_DIR, 'indexes'),
});
const workspaceModule = require('./lib/workspace');
const budgets = require('./lib/budgets');
const { createRoutes: workspaceRoutes } = require('./lib/workspace-routes');
const conversationView = require('./lib/conversation-view');
const { prepareTurn } = require('./lib/turn-preparation');
const { orderQueue } = require('./lib/queue-order');
const { createQueuedDispatcher } = require('./lib/queued-dispatch');
const notify = require('./lib/notify');
const settings = require('./lib/settings');
const scheduler = require('./lib/scheduler');
const {
  runTurn,
  resumeTurn: runnerResume,
  killTree,
  canFork,
  splitToolContent,
} = require('./lib/runner');
const inflight = require('./lib/inflight');
const silence = require('./lib/silence');
const grokCatalog = require('./lib/grok-catalog');
const modelSelection = require('./lib/model-selection');

const MODELS_FILE = path.join(__dirname, 'config', 'models.json');

const PORT = Number(process.env.PORT || 3901);
// Boucle locale par défaut : l'app exécute du code arbitraire et ne doit jamais être
// exposée par accident. Une adresse VPN explicite peut être fournie avec HOST.
const HOST = process.env.HOST || '127.0.0.1';
// Base de l'URL mise dans les notifications, pour qu'elles soient cliquables. Une valeur
// dans config/notify.json la remplace : l'adresse d'écoute n'est pas toujours le meilleur nom.
const APP_URL = `http://${HOST}:${PORT}`;

const PROVIDERS = new Set(['claude', 'codex', 'grok']);

/** Dernier message d'erreur du fil : ce qu'une notification doit citer. */
function lastErrorText(conv) {
  const items = (conv && conv.items) || [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].isError && items[i].text) return items[i].text;
  }
  return null;
}

/**
 * Remet à plat les conversations laissées en `working` par un arrêt du processus.
 *
 * Le déploiement se fait par `git push` puis `pm2 restart` : couper en plein turn n'est
 * pas un accident rare, c'est la procédure normale. Sans ça la pastille pulse
 * indéfiniment, et surtout un déclencheur reste affiché « en cours » dans la vue qui est
 * censée dire ce qui s'est passé pendant la nuit.
 *
 * Le CLI enfant meurt avec le processus. Mesuré le 03/08/2026 : PM2 tue tout l'arbre
 * (`treekill: true`, son défaut), et le `detached: true` du spawn n'y change rien. Le turn
 * s'arrête donc net — ce que l'avis doit dire, sans laisser espérer un travail qui
 * continuerait ailleurs.
 *
 * Rendre le turn survivable demanderait deux choses ensemble : `treekill: false` pour que le
 * process ne soit pas tué, ET une sortie écrite dans un fichier plutôt que dans un tuyau.
 * Vérifié : avec `treekill: false` seul, le CLI survit mais se bloque, son `stdout` pointant
 * vers un tuyau dont personne ne lit plus. Voir `docs/solutions/`.
 */
function reconcileOnBoot() {
  const INTERRUPTED =
    'Turn interrompu par un redémarrage du serveur. Le CLI a été arrêté avec lui : ' +
    "son travail s'est arrêté là, il ne continue pas en arrière-plan. Le contexte de la " +
    'conversation est intact — relance simplement la consigne.';

  // Turns retrouvés en vol : leur flux est dans un fichier, pas dans un tuyau mort. Si le
  // processus tourne encore, on reprend la lecture là où elle s'était arrêtée ; s'il est
  // parti, on lit tout ce qu'il a écrit pendant l'arrêt avant de conclure. Dans les deux
  // cas c'est mieux que de jeter le turn.
  const resumed = new Set();
  for (const record of inflight.list()) {
    const conv = store.get(record.convId);
    if (!conv) {
      inflight.close(record.convId);
      continue;
    }
    const running_ = inflight.alive(record.pid);
    try {
      resumeTurn(conv, record);
      resumed.add(conv.id);
      const item = store.addItem(conv.id, {
        kind: 'notice',
        text: running_
          ? "Redémarrage du serveur pendant ce turn : l'agent a continué de travailler, la lecture de son flux reprend où elle s'était arrêtée."
          : "Redémarrage du serveur pendant ce turn : ce que l'agent avait écrit avant d'être arrêté est récupéré ci-dessous.",
      });
      if (item) broadcast({ type: 'item', convId: conv.id, item });
    } catch (err) {
      console.error(`reprise impossible pour ${conv.id} : ${err.message}`);
      inflight.close(record.convId);
    }
  }

  let count = 0;
  for (const entry of store.list()) {
    if (entry.status !== 'working' || resumed.has(entry.id)) continue;
    const item = store.addItem(entry.id, { kind: 'result', isError: true, text: INTERRUPTED });
    if (item) broadcast({ type: 'item', convId: entry.id, item });
    setStatus(entry.id, 'error');
    count += 1;
  }

  for (const trigger of store.triggers()) {
    if (trigger.lastStatus === 'working') store.updateTrigger(trigger.id, { lastStatus: 'error' });
  }

  // Une exécution restée ouverte n'est pas une exécution en cours : le processus qui la
  // suivait n'existe plus. Sans cette clôture, l'historique afficherait « en cours » pour
  // toujours, et la question « est-ce que ça a planté » resterait sans réponse.
  for (const run of runs.open()) {
    runs.finish(run.convId, { status: 'error', error: INTERRUPTED });
  }

  if (count) console.log(`${count} conversation(s) restée(s) en cours remise(s) en erreur`);
  return count;
}

const app = express();
// Express 4 ne transmet pas tout seul les rejets des gestionnaires async.
const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(next);
};
app.param('id', (req, res, next, id) => {
  // Express décode aussi les barres %2f : aucun identifiant ne doit devenir un chemin
  // avant d'atteindre les helpers de fichiers (suppression comprise).
  if (!store.isSafeId(id)) {
    return res.status(400).json({ error: 'Identifiant invalide' });
  }
  next();
});
// Les images arrivent en data URL dans le corps JSON : 5 images de 10 Mo au plus,
// et le base64 gonfle d'un tiers.
app.use(express.json({ limit: '80mb' }));

// Les pièces jointes, servies pour les vignettes et l'ouverture d'un texte. Leur nom
// est généré et jamais réutilisé, donc on peut les mettre en cache longtemps.
// Un markdown servi comme du HTML exécuterait ce qu'il contient : on force un type
// inerte, et le navigateur n'a pas le droit de le deviner.
app.use(
  '/uploads',
  express.static(uploads.UPLOAD_DIR, {
    maxAge: '7d',
    immutable: true,
    index: false,
    setHeaders(res, filePath) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
      else if (ext === '.md') res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      else return;
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);
// Pas de cache navigateur : l'app est mono-utilisateur sur le réseau local, et un
// max-age faisait servir un app.js périmé après chaque déploiement. L'ETag suffit,
// la revalidation renvoie un 304 de quelques octets.
app.use(
  express.static(path.join(__dirname, 'public'), {
    maxAge: 0,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  })
);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// `ws` **recopie** les erreurs du serveur HTTP sur son propre émetteur. Sans ce gestionnaire,
// un `listen` en échec devient un « unhandled error event » sur le WebSocketServer et tue le
// process — y compris quand `lib/listen.js` avait prévu de réessayer. Mesuré le 05/08/2026 :
// la reprise fonctionnait, et l'application mourait quand même par ce second chemin.
wss.on('error', (err) => {
  // Les échecs de liaison appartiennent à `listenWithRetry`, qui les journalise et réessaie.
  if (listenRetryable(err && err.code)) return;
  console.error(`websocket : ${err.message}`);
});

const CONVERSATION_STREAM = new Set(['item', 'itemUpdate', 'delta']);

function sendAll(payload) {
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}

function broadcast(msg) {
  // Les gros événements d'un fil ne servent qu'aux onglets qui regardent ce fil. Les envoyer
  // à tous les téléphones multipliait le trafic et la mémoire tampon WebSocket, notamment sur
  // les sorties d'outils. L'activité légère reste globale pour rafraîchir la sidebar.
  if (msg && msg.convId && CONVERSATION_STREAM.has(msg.type)) {
    if (msg.type === 'item' || msg.type === 'itemUpdate') {
      sendAll(
        JSON.stringify({
          type: 'activity',
          convId: msg.convId,
          updatedAt: new Date().toISOString(),
        })
      );
    }

    const outgoing =
      msg.type === 'item' || msg.type === 'itemUpdate'
        ? { ...msg, item: conversationView.projectItem(msg.item) }
        : msg;
    const payload = JSON.stringify(outgoing);
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.agentHubConvId === msg.convId) client.send(payload);
    }
    return;
  }

  sendAll(JSON.stringify(msg));
}

// --- Turns en cours -------------------------------------------------------

/**
 * Turns en cours. La file d'attente n'est PAS ici : elle vit sur la conversation,
 * pour survivre à un redémarrage et se synchroniser entre appareils.
 * @type {Map<string, {child: import('child_process').ChildProcess|null, stopped: boolean}>}
 */
const running = new Map();

function selectionState(conv, active) {
  if (!conv) return null;
  const entry = running.get(conv.id);
  return modelSelection.state(
    conv,
    active === undefined ? (entry && entry.modelSelection) || null : active
  );
}

/**
 * Minuteurs de durée maximale des exécutions de déclencheurs, par conversation. Armés au
 * lancement, désarmés à la fin du turn — sans quoi un minuteur d'une heure survivrait à
 * un turn de trente secondes et interromprait la conversation suivante.
 * @type {Map<string, NodeJS.Timeout>}
 */
const killTimers = new Map();

// Les deltas de streaming sont éphémères (jamais persistés) et regroupés pour
// ne pas noyer le websocket en un événement par token.
const deltaBuffers = new Map();
let deltaTimer = null;

function queueDelta(convId, text, kind) {
  const key = `${convId}:${kind}`;
  deltaBuffers.set(key, (deltaBuffers.get(key) || '') + text);
  if (deltaTimer) return;
  deltaTimer = setTimeout(() => {
    deltaTimer = null;
    for (const [k, buffered] of deltaBuffers) {
      const idx = k.lastIndexOf(':');
      broadcast({
        type: 'delta',
        convId: k.slice(0, idx),
        kind: k.slice(idx + 1),
        text: buffered,
      });
    }
    deltaBuffers.clear();
  }, 60);
}

function setStatus(convId, status, activeSelection) {
  const conv = store.update(convId, { status });
  if (conv) {
    broadcast({
      type: 'status',
      convId,
      status,
      updatedAt: conv.updatedAt,
      modelSelection: selectionState(conv, activeSelection),
    });
  }
  // Un turn signalé muet qui s'achève : le signal doit tomber avec lui, sans attendre le
  // balayage suivant. Le cas est rare, et la vérification ne coûte qu'une comparaison.
  if (status !== 'working' && silentTurns.some((t) => t.convId === convId)) sweepSilence();
}

// --- Turns silencieux -----------------------------------------------------
//
// Un CLI qui reste en vie sans plus rien écrire ne se distingue par aucun signe d'un CLI qui
// travaille : dans les deux cas la pastille pulse. `lib/silence.js` dit pourquoi on signale
// au lieu d'interrompre, et pourquoi le seuil est à dix minutes.

/** @type {Array<{convId: string, idleMs: number, since: string}>} */
let silentTurns = [];

function sweepSilence() {
  const found = silence.scan(inflight.list());
  // Ne rien diffuser tant que la liste des conversations concernées ne bouge pas : leur
  // silence grandit à chaque tick, et le navigateur sait le recalculer depuis `since`.
  if (!silence.changed(silentTurns, found)) {
    silentTurns = found;
    return;
  }
  silentTurns = found;
  broadcast({ type: 'silent', turns: found });
}

// --- File d'attente -------------------------------------------------------
//
// Un message en attente n'entre PAS dans le fil : il vit dans la file, éditable et
// réordonnable, et ne devient un message de la conversation qu'au moment où il part.
// La file est stockée sur la conversation, donc elle survit à un rechargement et
// reste la même sur tous les appareils.

function publicQueue(conv) {
  return (conv.queue || []).map((q) => ({
    id: q.id,
    text: q.text,
    images: (q.images || []).map(({ url, name, kind }) => ({ url, name, kind })),
  }));
}

function broadcastQueue(conv) {
  broadcast({ type: 'queue', convId: conv.id, queue: publicQueue(conv) });
}

function enqueue(conv, text, saved) {
  const entry = {
    id: require('crypto').randomUUID(),
    text,
    images: saved,
    at: new Date().toISOString(),
  };
  const queue = [...(conv.queue || []), entry];
  store.update(conv.id, { queue });
  conv.queue = queue;
  broadcastQueue(conv);
  return entry;
}

function dequeue(conv, id) {
  const queue = conv.queue || [];
  const index = id ? queue.findIndex((q) => q.id === id) : 0;
  if (index === -1) return null;
  const [entry] = queue.splice(index, 1);
  store.update(conv.id, { queue });
  conv.queue = queue;
  broadcastQueue(conv);
  return entry;
}

/**
 * Transforme un message (immédiat ou sorti de la file) en turn qui démarre.
 * L'instantané est asynchrone : sur un gros dépôt le premier prend plusieurs
 * secondes, et le faire en synchrone gelait toute l'app.
 */
async function dispatch(conv, text, saved, extra, lifecycle) {
  // Relevé avant l'ajout : c'est le premier message qui donne son nom à la conversation, et
  // dans une seconde il ne sera plus le seul.
  const isFirst = !(conv.items || []).some((it) => it.kind === 'user');

  return prepareTurn({
    id: conv.id,
    running,
    exists: () => Boolean(store.get(conv.id)),
    prepare: async () => {
      setStatus(conv.id, 'working');
      return checkpoints.snapshot(conv, `avant : ${text.slice(0, 80)}`);
    },
    onCancel: () => setStatus(conv.id, 'stopped'),
    onError: () => {
      setStatus(conv.id, 'error');
      // Le premier turn n'a jamais été accepté : laisser l'objectif armé ferait prendre le
      // prochain message ordinaire pour la suite d'une boucle qui n'a pas commencé.
      if (extra && extra.goal === 'start') setGoal(conv.id, null);
    },
    start: (checkpoint, reservation) => {
      const item = store.addItem(conv.id, {
        kind: 'user',
        text,
        images: (saved || []).map(({ url, name, kind }) => ({ url, name, kind })),
        checkpoint,
        // Marque d'un message que l'application a rédigé — la consigne d'un tour d'objectif. Le
        // fil la replie : elle est longue, toujours la même, et ce n'est pas l'utilisateur qui
        // l'a écrite. Elle reste visible, comme la demande de rapport.
        ...(extra || {}),
      });
      broadcast({ type: 'item', convId: conv.id, item });
      // À partir d'ici le message est dans le fil. Un message auparavant en file ne doit plus
      // y être restauré si le spawn échoue : ce serait le montrer deux fois au prochain essai.
      if (lifecycle && lifecycle.onAccepted) lifecycle.onAccepted(item);
      // L'objet entier, pas seulement le chemin : le prompt nomme le fichier comme
      // l'utilisateur l'a envoyé, et distingue une image d'un texte.
      startTurn(conv, text, saved || [], undefined, reservation);

      // Le titrage part en parallèle du travail, sans l'attendre : il a son propre process, et le
      // nom doit apparaître dans la barre latérale tout de suite, pas à la fin du turn. Hors
      // requête HTTP à ce stade — personne pour recevoir un rejet, on journalise.
      // Ce qui nomme, c'est ce que l'utilisateur a demandé — pas l'enveloppe que l'application a
      // écrite autour. Un premier tour d'objectif porte donc son objectif, pas sa consigne de boucle.
      if (isFirst && conv.titleAuto !== false) {
        nameConversation(conv, (extra && extra.goalText) || text).catch((err) =>
          console.error(`titrage impossible pour ${conv.id} : ${err.message}`)
        );
      }
      return item;
    },
  });
}

/**
 * Lance un message déjà en file sans le perdre pendant l'instantané asynchrone.
 *
 * Il est retiré immédiatement pour empêcher une édition concurrente. Si la préparation est
 * annulée ou échoue avant que le message rejoigne le fil, il retrouve sa position. Une fois
 * accepté, une erreur de spawn reste visible dans le fil et ne doit surtout pas le dupliquer.
 */
const { dispatchQueued } = createQueuedDispatcher({
  store,
  broadcastQueue,
  dequeue,
  dispatch,
});

/**
 * Construit les gestionnaires d'un turn, sans le lancer.
 *
 * Séparé de `startTurn` parce qu'un turn peut aussi être **repris** : celui qu'un
 * redémarrage a coupé garde son flux dans un fichier, et le relire demande exactement les
 * mêmes gestionnaires. Les dupliquer aurait garanti qu'ils divergent.
 *
 * @returns {{handlers: object, done: Promise}}
 */
function buildTurn(conv, options, originalStartedAt, activeSelection) {
  // À la reprise, le turn n'a pas recommencé avec agentHub : le CLI a continué pendant le
  // redémarrage. Repartir de Date.now() ferait disparaître toute cette durée du relevé final.
  const suppliedStart = Number(originalStartedAt);
  const turnStartedAt = Number.isFinite(suppliedStart) && suppliedStart > 0
    ? suppliedStart
    : Date.now();
  const turnSelection = activeSelection || modelSelection.snapshot(conv, {
    startedAt: new Date(turnStartedAt).toISOString(),
  });
  // Valeurs à masquer dans tout ce que l'agent produira. Relevées une fois au démarrage du
  // turn plutôt qu'à chaque item : le fichier ne bouge pas pendant un turn, et le faire à
  // chaque ligne de sortie coûterait une lecture disque par chunk.
  // Le jeton du panneau rejoint la liste : il entre dans l'environnement de l'agent comme un
  // secret de projet, donc il ressort dans un `env`, dans un `curl` recopié, ou dans un
  // message d'erreur. Le masquer ici est ce qui l'empêche d'être écrit dans le journal des
  // items — c'est-à-dire sur le disque, pour toujours.
  // Retrié du plus long au plus court, comme le fait `secrets.values` : si un secret en
  // contient un autre, remplacer le court d'abord laisserait des morceaux du long en clair.
  const masked = [...secrets.values(conv.folder), panel.token()]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let settle;
  const done = new Promise((resolve) => {
    settle = resolve;
  });
  let structured = null;
  let turnModelEvidence = null;
  // Codex peut produire un résultat d'erreur puis `turn.failed`; un fatal peut aussi être
  // suivi du relevé partiel reconstitué. La durée appartient au turn et ne doit être écrite
  // qu'une fois, même si les tokens de chaque résultat restent tous journalisés.
  let durationJournalized = false;

  // Un même message arrive souvent plusieurs fois (Codex émet `error` puis
  // `turn.failed`, et le process sort ensuite en code non nul). On l'affiche une
  // seule fois, et si un avis se révèle être la cause de l'échec on le repeint en
  // erreur au lieu d'ajouter un doublon : la sévérité vient du résultat du turn,
  // pas du type d'événement.
  let turnFailed = false;
  const shown = new Map(); // texte -> item persisté

  const textKey = (text) => String(text || '').trim().slice(0, 300);

  const handlers = {
    onSession(sessionId) {
      const patch = { sessionStarted: true };
      if (!conv.providerSessionId) patch.providerSessionId = sessionId;
      // Le fork a eu lieu : la conversation a maintenant sa propre session, et le turn
      // suivant doit la reprendre plutôt que reforker celle du parent. Si le turn avait
      // échoué avant l'init, le champ resterait en place et le fork serait retenté.
      if (conv.forkFrom) patch.forkFrom = null;
      store.update(conv.id, patch);
      Object.assign(conv, patch);
    },

    onSkills(found) {
      // Le catalogue ne bouge qu'à l'installation d'un plugin : n'écrire et ne diffuser
      // que sur changement réel évite de réécrire un fichier à chaque turn.
      if (skills.remember(conv.provider, found)) {
        broadcast({ type: 'skills', provider: conv.provider });
      }
    },

    onDelta(text, kind) {
      // Le streaming part directement au navigateur, sans passer par le store : c'est le
      // chemin le plus court vers l'écran, donc celui qu'il ne faut surtout pas oublier.
      queueDelta(conv.id, secrets.redact(text, masked), kind);
    },

    onItem(rawItem) {
      // Masquage avant toute chose : ce qui passe ici est écrit dans le journal et diffusé.
      // En profondeur, car un secret peut sortir dans les *arguments* d'un outil autant que
      // dans son résultat — un `curl -H "Bearer sk-…"` écrit en clair l'expose.
      const item = secrets.redactDeep(rawItem, masked);

      if (item.kind === 'result') {
        if (!(Number(item.durationMs) > 0)) item.durationMs = Date.now() - turnStartedAt;
        const active = running.get(conv.id);
        if (item.structuredOutput) structured = item.structuredOutput;
        const usageItem = durationJournalized ? { ...item, durationMs: 0 } : item;
        const journalized = usage.record({
          provider: conv.provider,
          convId: conv.id,
          item: usageItem,
          fallbackModel: turnSelection.launchedModel,
          triggerId: conv.triggerId || null,
          // Le dépôt, et non le worktree : sinon chaque branche isolée compterait comme un
          // projet à elle. Écrit sur la ligne pour que le coût survive à la conversation.
          project: notes.projectOf(conv),
        });
        if (Number(usageItem.durationMs) > 0) durationJournalized = true;
        if (active) active.usageFinalized = true;
        const patch = {};
        turnModelEvidence = modelSelection.mergeLast(
          turnModelEvidence,
          modelSelection.lastFromResult(item, turnSelection)
        );
        const lastModelSelection = turnModelEvidence;
        // `lastModels` reste pour les anciens clients, mais sa provenance explicite vit à
        // côté : aucun défaut de pricing n'est désormais présenté comme une mesure du CLI.
        patch.lastModels = lastModelSelection.models;
        patch.lastModelSelection = lastModelSelection;
        // Le coût du turn : celui du fournisseur s'il le chiffre, sinon la somme des lignes
        // qu'on vient d'écrire. Ce repli est le seul chiffre dont disposent Codex, qui ne
        // chiffre jamais rien, et un turn coupé avant son relevé final — sans lui, une
        // conversation Codex affichait un coût nul de bout en bout.
        const costUsd =
          item.costUsd || journalized.reduce((sum, row) => sum + (row.costUsd || 0), 0);
        if (costUsd) {
          patch.lastCostUsd = costUsd;
          patch.totalCostUsd = (conv.totalCostUsd || 0) + costUsd;
        }
        // Taille du contexte : le prompt du dernier appel API de ce turn, c'est-à-dire
        // la dernière itération. Somme entrée + cache lu + cache écrit.
        if (item.usage) {
          const iterations = Array.isArray(item.usage.iterations) ? item.usage.iterations : null;
          const last = iterations && iterations.length ? iterations[iterations.length - 1] : item.usage;
          patch.contextTokens =
            (last.input_tokens || 0) +
            (last.cache_read_input_tokens || 0) +
            (last.cache_creation_input_tokens || 0);
        }
        if (item.modelUsage) {
          const windows = Object.values(item.modelUsage)
            .map((m) => m.contextWindow || 0)
            .filter(Boolean);
          if (windows.length) patch.contextWindow = Math.max(...windows);
        }
        // Codex ne publie pas la taille de sa fenêtre : on remonte le contexte en
        // valeur absolue, l'UI affiche alors des tokens sans pourcentage.
        if (item.codexUsage) {
          patch.contextTokens =
            (item.codexUsage.inputTokens || 0) + (item.codexUsage.cacheReadTokens || 0);
        }
        if (Object.keys(patch).length) {
          store.update(conv.id, patch);
          Object.assign(conv, patch);
        }
        // Un result sans erreur n'apporte rien à l'historique : les métriques
        // vivent sur la conversation, pas dans le fil.
        if (!item.isError) {
          // On n'envoie que ce que l'UI lit : `item` porte aussi tout le détail
          // `usage` et `modelUsage`, inutile sur le fil websocket.
          broadcast({
            type: 'metrics',
            convId: conv.id,
            durationMs: item.durationMs,
            numTurns: item.numTurns,
            ...patch,
            modelSelection: selectionState(conv, turnSelection),
          });
          return null;
        }
        turnFailed = true;
        const existing = shown.get(textKey(item.text));
        if (existing) {
          // Ce message est déjà dans le fil sous forme d'avis : on le repeint.
          existing.kind = 'result';
          existing.isError = true;
          store.touchItem(conv.id, existing);
          broadcast({ type: 'itemUpdate', convId: conv.id, item: existing });
          return null;
        }
      }
      // Images déjà présentes sur l'item : c'est le cas de Codex, dont l'appel d'outil
      // MCP arrive complet. Le base64 est écrit sur disque et ne rejoint jamais le
      // journal — un fil rempli de captures encodées serait illisible et énorme.
      if (item.resultImages) {
        const files = uploads.saveFromTool(conv.id, item.resultImages);
        delete item.resultImages;
        if (files.length) item.images = files;
      }
      const saved = store.addItem(conv.id, item);
      if (saved && (item.kind === 'notice' || item.isError)) {
        shown.set(textKey(item.text), saved);
      }
      broadcast({ type: 'item', convId: conv.id, item: saved });
      return saved;
    },

    onToolResult(item, content, isError) {
      const { text, images } = splitToolContent(content);
      item.result = secrets.redact(text, masked);
      item.isError = Boolean(isError);
      if (images.length) {
        const saved = uploads.saveFromTool(conv.id, images);
        if (saved.length) item.images = saved;
      }
      // Le résultat arrive après l'appel : la nouvelle version de l'item est ajoutée en
      // fin de journal et prime à la relecture. Sans ça il n'est que diffusé, et le fil
      // rouvert montre des outils sans aucune sortie.
      store.touchItem(conv.id, item);
      broadcast({ type: 'itemUpdate', convId: conv.id, item });
    },

    onExit(code, rawStderr, fatalReported) {
      const entry = running.get(conv.id);
      running.delete(conv.id);
      const stopped = Boolean(entry && entry.stopped);
      // Un CLI qui échoue recrache volontiers sa ligne de commande ou son environnement.
      const stderr = secrets.redact(rawStderr, masked);

      if (entry && entry.stopped) {
        setStatus(conv.id, 'stopped');
      } else if (fatalReported || turnFailed) {
        // Le message d'erreur est déjà dans le fil : pas de doublon.
        setStatus(conv.id, 'error');
      } else if (code !== 0) {
        const saved = store.addItem(conv.id, {
          kind: 'result',
          isError: true,
          text: stderr || `L'agent s'est arrêté avec le code ${code}`,
        });
        broadcast({ type: 'item', convId: conv.id, item: saved });
        setStatus(conv.id, 'error');
      } else {
        setStatus(conv.id, 'done');
      }

      // Exécution de déclencheur : son issue remonte sur le déclencheur, qui est ce que
      // l'utilisateur regarde. Le minuteur de durée maximale n'a plus lieu d'être.
      const killTimer = killTimers.get(conv.id);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimers.delete(conv.id);
      }
      const outcome = stopped
        ? 'stopped'
        : fatalReported || turnFailed || code !== 0
          ? 'error'
          : 'done';

      const trigger = conv.triggerId ? store.getTrigger(conv.triggerId) : null;
      const fresh = store.get(conv.id);
      if (trigger) {
        store.updateTrigger(conv.triggerId, { lastStatus: outcome });
        // L'historique est clos à chaque fin de turn. Une exécution qui enchaîne sur un
        // message en attente sera donc réécrite : c'est le dernier turn qui fait foi, et
        // la durée court du lancement jusqu'à lui.
        runs.finish(conv.id, {
          status: outcome,
          costUsd: (fresh || conv).totalCostUsd || 0,
          error: outcome === 'error' ? lastErrorText(fresh) || stderr : null,
        });
        broadcast({ type: 'triggers', triggers: store.triggers() });
      }

      // Turns de service : le rapport de fin et la vérification du mode objectif. Ni l'un ni
      // l'autre ne conclut quoi que ce soit — leur appelant s'en charge, en décrivant l'issue
      // du **travail** et non la leur.
      const isReport = Boolean((options || {}).isReport);
      const isGoalCheck = Boolean((options || {}).isGoalCheck);
      // Le turn qui tire une leçon est du même genre : il ne conclut rien du travail, il le
      // relit. Sans ce drapeau, il enchaînerait sur lui-même — une leçon tirée d'un turn dont
      // le seul fait notable est d'avoir tiré une leçon.
      const isMemory = Boolean((options || {}).isMemory);
      // Une note de passation décrit le travail, elle ne le poursuit pas. En particulier,
      // elle ne doit pas faire avancer un objectif actif ni déclencher une notification.
      const isHandoff = Boolean((options || {}).isHandoff);
      const silent = isReport || isGoalCheck || isMemory || isHandoff;

      // Messages mis en attente pendant que l'agent travaillait : le premier part
      // maintenant, et c'est à cet instant seulement qu'il rejoint le fil.
      //
      // Sauf derrière une vérification d'objectif : sa boucle est en train de décider de la
      // relance, et démarrer un turn ici en ferait deux à la fois sur la même conversation —
      // deux CLIs écrivant dans le même fichier de flux. La file part au turn de travail
      // suivant, qui lui enchaîne normalement.
      let chained = false;
      if (fresh && (fresh.queue || []).length && !(entry && entry.stopped) && !isGoalCheck) {
        const next = fresh.queue[0];
        // Hors requête HTTP : personne pour recevoir un rejet, on le journalise.
        if (next) {
          chained = true;
          dispatchQueued(fresh, next).catch((err) =>
            console.error(`envoi du message en attente impossible : ${err.message}`)
          );
        }
      }

      // Mode objectif : un turn qui finit ne veut pas dire que l'objectif est atteint. La
      // suite — vérifier, relancer, ou conclure — est asynchrone, et c'est elle qui décidera
      // du rapport et de la notification.
      if (!chained && !silent && goals.decide((fresh || conv).goal, outcome)) {
        // Hors requête HTTP : rien pour recevoir un rejet, on journalise.
        pursueGoal(fresh || conv, trigger, outcome, stderr).catch((err) =>
          console.error(`mode objectif impossible : ${err.message}`)
        );
        settle({
          stopped,
          failed: fatalReported || turnFailed || code !== 0,
          code,
          stderr,
          structured,
        });
        return;
      }

      // Équipe : une étape qui finit passe la main à la suivante. Après l'objectif, qui a
      // ses propres relances à décider, et avant le rapport : une étape d'équipe n'est pas
      // une exécution de déclencheur.
      const inTeam = !chained && !silent ? team.forConv(conv.id) : null;
      if (inTeam && inTeam.run.status === 'running') {
        // Hors requête HTTP : rien pour recevoir un rejet, on journalise.
        advanceTeam(inTeam.run, inTeam.stage, outcome).catch((err) =>
          console.error(`étape d'équipe suivante impossible : ${err.message}`)
        );
        notifyEnd({
          conv: fresh || conv,
          trigger,
          outcome,
          error: outcome === 'error' ? lastErrorText(fresh) || stderr : null,
        });
        settle({
          stopped,
          failed: fatalReported || turnFailed || code !== 0,
          code,
          stderr,
          structured,
        });
        return;
      }

      if (!chained && !silent && trigger && trigger.report && outcome === 'done') {
        // Hors requête HTTP : rien pour recevoir un rejet, on journalise.
        produceReport(fresh || conv, trigger).catch((err) =>
          console.error(`rapport impossible : ${err.message}`)
        );
        settle({ stopped, failed: false, code, stderr, structured });
        return;
      }

      // Mémoire de projet : un turn qui s'est cogné et qui s'en est sorti a peut-être appris
      // quelque chose. Lancé après la notification de rien du tout — c'est un turn de service,
      // il ne doit ni retarder la suite ni la décider.
      if (!chained && !silent) {
        proposeLesson(fresh || conv, outcome).catch((err) =>
          console.error(`mémoire de projet impossible : ${err.message}`)
        );
      }

      // Notification sortante. Elle attend que la file soit vide : tant qu'un message
      // enchaîne, l'agent n'a pas fini et prévenir serait faux.
      if (!chained && !silent) {
        notifyEnd({
          conv: fresh || conv,
          trigger,
          outcome,
          error: outcome === 'error' ? lastErrorText(fresh) || stderr : null,
        });
      }

      settle({
        stopped,
        failed: fatalReported || turnFailed || code !== 0,
        code,
        stderr,
        structured,
      });
    },
  };

  return { handlers, done };
}

/**
 * Lance un turn. Renvoie une promesse résolue à la sortie du process, avec l'issue du
 * turn : le relais croisé a besoin d'attendre la fin d'un turn pour en lire le résultat,
 * là où un envoi ordinaire n'attend rien.
 *
 * @param {{schema?: object, isReport?: boolean}} [options] `schema` contraint la réponse
 *   finale de l'agent à un schéma JSON — l'objet validé revient dans `structured`.
 *   `isReport` marque le turn de rapport, qui ne doit ni en déclencher un autre ni notifier.
 * @returns {Promise<{stopped: boolean, failed: boolean, code: number, stderr: string,
 *   structured: object|null}>}
 */
function startTurn(conv, prompt, imagePaths, options, reservation) {
  if (running.has(conv.id) && running.get(conv.id) !== reservation) {
    const err = new Error('Un turn est déjà en cours dans cette conversation.');
    err.statusCode = 409;
    throw err;
  }
  const selected = modelSelection.snapshot(conv);
  // Le clone porte les arguments immuables du turn ; la conversation canonique reste
  // modifiable pour que le sélecteur prépare le turn suivant pendant que celui-ci travaille.
  const launched = {
    ...conv,
    model: selected.launchedModel,
    effort: selected.launchedEffort,
  };
  setStatus(conv.id, 'working', selected);
  const { handlers, done } = buildTurn(conv, options, undefined, selected);
  const child = runTurn(launched, prompt, handlers, imagePaths, {
    ...(options || {}),
    modelSelection: selected,
  });
  running.set(conv.id, {
    child,
    stopped: false,
    startedAt: Date.parse(selected.startedAt),
    modelSelection: selected,
  });
  return done;
}

/**
 * Reprend un turn retrouvé en vol au démarrage.
 *
 * L'entrée de `running` porte un simple `{ pid }` et non un objet enfant : on n'a pas lancé
 * ce processus, mais `killTree` n'a besoin que de son identifiant — c'est ce qui permet
 * d'interrompre depuis l'interface un turn qu'on a seulement retrouvé.
 */
function resumeTurn(conv, record) {
  // inflight.open écrit une date ISO. On la convertit une fois et on partage exactement la
  // même origine entre le relevé final et la durée active exposée aux budgets.
  const parsedStart = Date.parse(record.startedAt);
  const startedAt = Number.isFinite(parsedStart) ? parsedStart : Date.now();
  const selected = modelSelection.restore(record, conv, {
    startedAt: new Date(startedAt).toISOString(),
  });
  setStatus(conv.id, 'working', selected);
  const { handlers } = buildTurn(conv, {}, startedAt, selected);
  const active = {
    child: { pid: record.pid }, stopped: false,
    startedAt,
    modelSelection: selected,
  };
  // runnerResume draine immédiatement ce qui a été écrit pendant l'arrêt. L'entrée doit
  // exister avant ce drain pour qu'un résultat déjà présent puisse marquer usageFinalized ;
  // sinon le budget additionnerait provisoirement durée persistée et durée encore « active ».
  running.set(conv.id, active);
  try {
    return runnerResume(record, conv, handlers);
  } catch (err) {
    if (running.get(conv.id) === active) running.delete(conv.id);
    throw err;
  }
}

// --- Turns hors fil -------------------------------------------------------
//
// Certains services ont besoin d'un agent sans avoir besoin d'une conversation : nommer un fil,
// tenir le chat des skills. Les faire passer par une vraie conversation les rendrait visibles
// dans la barre latérale et polluerait la session de travail ; les faire passer par `startTurn`
// écrirait leurs items dans un fil.
//
// D'où ce chemin court : le même lanceur, les mêmes traducteurs de flux, mais des gestionnaires
// qui ne persistent rien. Ce qui reste enregistré, et délibérément, c'est la **consommation** :
// un turn qui coûte doit apparaître dans le journal, même quand personne ne le voit.
//
// L'identifiant sert de clé aux fichiers de flux (`data/turns/<id>.jsonl`). Il ne correspond à
// aucune conversation : au démarrage, `reconcileOnBoot` ne trouve rien dans le store et referme
// simplement l'enregistrement — c'est le comportement voulu, un service hors fil ne se reprend
// pas.

/**
 * Lance un agent pour une seule réponse, sans fil ni item.
 *
 * @param {object} spec
 * @param {string} spec.id clé des fichiers de flux — unique par appel, ou stable pour un
 *   service qui garde sa session
 * @param {string} spec.provider
 * @param {string} spec.cwd
 * @param {string} spec.prompt
 * @param {object} [spec.schema] contraint la réponse finale, qui revient dans `structured`
 * @param {string} [spec.model] modèle imposé — par défaut celui du compte
 * @param {string} [spec.sessionId] session à reprendre, pour un service qui continue
 * @param {boolean} [spec.sessionStarted] la session existe déjà côté CLI
 * @param {Function} [spec.onSession] appelée avec l'identifiant de session ouvert
 * @param {Function} [spec.onDelta] texte au fil de l'eau
 * @param {Function} [spec.onTool] appels d'outils, pour donner à voir l'avancement
 * @param {Function} [spec.onStart] reçoit le process, pour pouvoir l'interrompre
 * @returns {Promise<{structured: object|null, text: string, failed: boolean, stderr: string}>}
 */
function oneShotTurn(spec) {
  const conv = {
    id: spec.id,
    provider: spec.provider,
    cwd: spec.cwd,
    model: spec.model || null,
    effort: spec.effort || null,
    browser: false,
    // Pas de dossier, donc pas de secrets de projet : ces turns ne travaillent pas.
    folder: null,
    providerSessionId: spec.sessionId || require('crypto').randomUUID(),
    sessionStarted: Boolean(spec.sessionStarted && spec.sessionId),
    forkFrom: null,
  };

  return new Promise((resolve) => {
    let structured = null;
    const texts = [];
    const handlers = {
      onSession(sessionId) {
        if (spec.onSession) spec.onSession(sessionId);
      },
      onSkills(found) {
        // Le catalogue s'apprend là où on le croise, y compris ici : c'est le même
        // événement `init` que dans un turn ordinaire.
        if (skills.remember(conv.provider, found)) {
          broadcast({ type: 'skills', provider: conv.provider });
        }
      },
      onDelta(text, kind) {
        if (spec.onDelta) spec.onDelta(text, kind);
      },
      onItem(item) {
        if (item.kind === 'result') {
          if (item.structuredOutput) structured = item.structuredOutput;
          usage.record({
            provider: conv.provider,
            convId: conv.id,
            item,
            fallbackModel: conv.model,
            triggerId: null,
          });
          return null;
        }
        if (item.kind === 'text' && item.text) texts.push(item.text);
        if (item.kind === 'tool' && spec.onTool) spec.onTool(item);
        // Rien n'est persisté : ce turn n'a pas de fil où poser un item.
        return null;
      },
      onToolResult() {},
      onExit(code, stderr, fatalReported) {
        resolve({
          structured,
          text: texts.join('\n\n').trim(),
          failed: Boolean(fatalReported) || code !== 0,
          stderr: stderr || '',
        });
      },
    };

    try {
      const child = runTurn(conv, spec.prompt, handlers, [], { schema: spec.schema || null });
      if (spec.onStart) spec.onStart(child);
    } catch (err) {
      resolve({ structured: null, text: '', failed: true, stderr: err.message });
    }
  });
}

/**
 * Fait nommer une conversation par le modèle, d'après son premier message.
 *
 * Ne lance jamais et ne fait jamais échouer quoi que ce soit : un titre est un confort. Si le
 * turn rate, le titre provisoire — la première ligne du message — reste en place.
 */
async function nameConversation(conv, firstMessage) {
  const outcome = await oneShotTurn({
    id: `titre-${conv.id}`,
    provider: conv.provider,
    cwd: conv.cwd,
    model: titles.modelFor(conv.provider),
    prompt: titles.buildPrompt(firstMessage),
    schema: titles.SCHEMA,
  });

  const written = titles.normalize(outcome.structured);
  if (!written) return null;

  // Renommé à la main entre-temps : sa décision passe avant celle du modèle.
  const fresh = store.get(conv.id);
  if (!fresh || fresh.titleAuto === false) return null;

  store.update(conv.id, { title: written, titleAuto: true });
  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === conv.id) });
  return written;
}

// --- API ------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    host: os.hostname(),
    // Le fuseau dans lequel les échéances de déclencheurs sont calculées.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toString(),
    running: [...running.keys()],
  });
});

/**
 * Quels fournisseurs sont utilisables, et sous quel compte.
 *
 * Remplace l'ancien test d'existence de fichier de `/api/health`, qui déclarait connecté
 * un compte dont le jeton était révoqué — le 401 n'apparaissait qu'au premier turn.
 */
registerConnectionsRoutes({
  app,
  asyncRoute,
  providers: PROVIDERS,
  accounts,
  login,
  googleOauth,
  remoteBrowser,
  authRequests,
  watchBrowser,
  store,
  running,
  enqueue,
  dispatch,
  broadcast,
});

// --- Demandes d'arbitrage --------------------------------------------------
//
// Un agent bloqué sur une décision ambiguë pose sa question et termine son turn ; la réponse
// humaine le relance. Même mécanique que les demandes de connexion, à ceci près que ce n'est
// pas le navigateur du serveur qui débloque mais une phrase.

// --- Serveur MCP : l'outil `ask_user` --------------------------------------
//
// Le seul endroit de l'application où une réponse HTTP est volontairement tenue ouverte
// plusieurs minutes : c'est l'attente elle-même. L'agent appelle l'outil, la requête reste
// suspendue jusqu'à la réponse humaine, et le turn ne s'interrompt pas.
//
// L'identifiant de conversation est dans l'URL, écrite par `runTurn` pour ce turn-là. Un
// agent ne peut donc pas se tromper de conversation, ni en désigner une autre.

/**
 * Neutralise les délais de socket sur une requête tenue longtemps.
 *
 * `requestTimeout` de Node borne la *réception* de la requête et ne devrait pas s'appliquer
 * ici — mais il est mesuré depuis l'arrivée de la requête, et sa valeur par défaut (5 min)
 * est inférieure à notre plafond d'attente. On le désarme explicitement plutôt que de
 * dépendre d'une lecture fine de la documentation.
 */
function holdOpen(req, res) {
  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setKeepAlive(true);
}

app.post(['/mcp', '/mcp/:convId'], asyncRoute(async (req, res) => {
  holdOpen(req, res);
  const convId = req.params.convId || null;
  const body = req.body;

  // Un lot JSON-RPC est autorisé par la spécification. Les CLIs n'en envoient pas, mais le
  // refuser silencieusement donnerait un serveur qui marche « sauf parfois ».
  const messages = Array.isArray(body) ? body : [body];
  const answers = [];
  for (const message of messages) {
    let reply;
    try {
      reply = await mcpServer.dispatch(message, convId, {
        resolveConv: (id) => Boolean(store.get(id)),
        onCreate: (row) => announceAsk(row),
        onSettle: (row) => broadcast({ type: 'ask-answered', ask: row }),
      });
    } catch (err) {
      console.error(`mcp : ${err.message}`);
      reply = { jsonrpc: '2.0', id: (message && message.id) ?? null, error: { code: -32603, message: err.message } };
    }
    if (reply) answers.push(reply);
  }

  // Que des notifications : la spécification demande un 202 sans corps.
  if (!answers.length) return res.status(202).end();
  res.json(Array.isArray(body) ? answers : answers[0]);
}));

// Le client tente parfois d'ouvrir un flux serveur. On n'en a pas : la spécification prévoit
// exactement ce refus, et le client s'en contente au lieu de considérer le serveur en panne.
app.get(['/mcp', '/mcp/:convId'], (req, res) => res.status(405).end());
app.delete(['/mcp', '/mcp/:convId'], (req, res) => res.status(200).end());

/** Une question arrive : avis dans le fil, diffusion, notification. */
function announceAsk(ask) {
  const conv = store.get(ask.convId);
  const item = store.addItem(ask.convId, {
    kind: 'notice',
    text: `L'agent attend une réponse : ${ask.question}`,
    askId: ask.id,
  });
  if (item) broadcast({ type: 'item', convId: ask.convId, item });
  broadcast({ type: 'ask', ask });
  if (conv) scheduleAskNotice(ask);
}

/**
 * Sonner ailleurs, mais pas dans le vide ni dans le dos de qui est déjà là.
 *
 * Si quelqu'un a la conversation sous les yeux, on lui laisse une minute : il va
 * probablement répondre, et une notification serait du bruit — c'est le cas le plus fréquent,
 * on est devant l'écran quand on lance un agent. Si personne ne regarde — écran verrouillé,
 * onglet en arrière-plan, ou téléphone ouvert sur un autre fil —, il n'y a rien à attendre.
 *
 * Le délai n'est pas un délai d'envoi mais une **fenêtre d'annulation** : la question est
 * relue à son échéance, et une réponse arrivée entre-temps l'annule.
 */
function scheduleAskNotice(ask) {
  if (!presence.watching(ask.convId)) return sendAskNotice(ask);

  const timer = setTimeout(() => {
    const still = asks.get(ask.id);
    if (still && still.status === 'pending') sendAskNotice(still);
  }, presence.GRACE_MS);
  // Une notification en sursis ne doit pas retenir le process à l'arrêt.
  if (typeof timer.unref === 'function') timer.unref();
}

function sendAskNotice(ask) {
  const conv = store.get(ask.convId);
  if (!conv) return;
  // `always` et non `inherit` : une question que personne ne voit bloque le travail pour
  // de bon, là où une notification de fin manquée ne coûte qu'un coup d'œil en retard.
  notify
    .send({
      conv,
      outcome: 'ask',
      mode: 'always',
      note: ask.question,
      // Ce qui met les boutons de réponse dans la notification : le téléphone poste
      // lui-même la réponse, sans passer par l'application.
      ask,
      error: null,
      triggerName: null,
      appUrl: APP_URL,
    })
    .catch((err) => console.error(`notification d'arbitrage : ${err.message}`));
}

/**
 * Qui regarde quoi. Sert à répondre à « pourquoi je n'ai pas été notifié ? », question
 * autrement impossible à instruire : la décision se prend sur un état qui ne laisse aucune
 * trace une fois la seconde passée.
 */
app.get('/api/presence', (req, res) => {
  res.json({ clients: presence.snapshot(), graceMs: presence.GRACE_MS });
});

app.get('/api/asks', (req, res) => {
  res.json({ asks: asks.list(req.query.status || 'pending') });
});

app.post('/api/asks', (req, res) => {
  const body = req.body || {};
  const conv = store.get(String(body.convId || ''));
  if (!conv) return res.status(404).json({ error: 'Conversation inconnue' });
  let ask;
  try {
    // `turn` imposé : rien n'attend derrière cette route. Laisser passer un `mode` du corps
    // permettrait de créer une demande « live » que personne ne débloquerait jamais.
    ask = asks.create({ ...body, mode: 'turn' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  announceAsk(ask);
  res.status(201).json({ ask });
});

app.post('/api/asks/:id/answer', (req, res) => {
  const pending = asks.get(req.params.id);
  if (!pending) return res.status(404).json({ error: 'Demande inconnue' });
  if (pending.status !== 'pending') {
    return res.status(409).json({ error: 'Cette demande a déjà reçu une réponse.' });
  }
  const conv = store.get(pending.convId);
  if (!conv) return res.status(404).json({ error: 'Conversation inconnue' });

  // Relevé AVANT la réponse : `answer` résout l'attente, et après coup on ne saurait plus
  // si un agent était suspendu dessus ou non.
  const waiting = asks.hasWaiter(pending.id);

  let answered;
  try {
    answered = asks.answer(pending.id, (req.body || {}).answer);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  // `answer` refuse la seconde réponse : deux clics rapides ne relancent qu'un turn.
  if (!answered) return res.status(409).json({ error: 'Cette demande a déjà reçu une réponse.' });

  // Un appel d'outil suspendu vient d'être débloqué : l'agent a la réponse et poursuit son
  // turn tout seul. Lui envoyer en plus une consigne de reprise lui ferait refaire le
  // travail au tour suivant.
  if (!waiting) {
    const prompt = asks.resumePrompt(answered);
    if (running.has(conv.id)) enqueue(conv, prompt, null);
    else {
      dispatch(conv, prompt, null, { askResume: true }).catch((err) =>
        console.error(`reprise apres arbitrage impossible : ${err.message}`)
      );
    }
  }
  broadcast({ type: 'ask-answered', ask: answered });
  res.json({ ask: answered, resumed: !waiting });
});

// --- Bloc-notes d'un projet ------------------------------------------------
//
// Des tickets rangés par projet, lisibles et modifiables par l'interface comme par les
// agents. Le projet se désigne soit directement, soit par la conversation d'où l'on parle —
// c'est cette seconde forme que les agents utilisent, ne connaissant qu'eux-mêmes.

/** Projet visé par une requête, et l'erreur à renvoyer s'il n'est pas déterminable. */
function notesProject(body) {
  const convId = String((body && body.convId) || '');
  if (convId) {
    const conv = store.get(convId);
    if (!conv) return { error: 'Conversation inconnue' };
    const project = notes.projectOf(conv);
    return project ? { project } : { error: "Cette conversation n'a pas de projet" };
  }
  const project = notes.key((body && body.project) || '');
  return project ? { project } : { error: 'Projet manquant' };
}

function broadcastNotes(project) {
  broadcast({ type: 'notes', project, tickets: notes.list(project) });
}

app.get('/api/notes', (req, res) => {
  const found = notesProject(req.query);
  if (found.error) return res.status(400).json({ error: found.error });
  res.json({ project: found.project, tickets: notes.list(found.project) });
});

app.post('/api/notes', (req, res) => {
  const found = notesProject(req.body);
  if (found.error) return res.status(400).json({ error: found.error });
  try {
    const ticket = notes.create(found.project, req.body || {});
    broadcastNotes(found.project);
    res.status(201).json({ ticket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST et non PATCH : c'est la même route pour l'interface et pour un `curl` d'agent, et un
// verbe de moins à retenir dans une consigne est un échec de moins.
app.post('/api/notes/:id', (req, res) => {
  try {
    const ticket = notes.update(req.params.id, req.body || {});
    if (!ticket) return res.status(404).json({ error: 'Ticket inconnu' });
    broadcastNotes(ticket.project);
    res.json({ ticket });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/notes/:id', (req, res) => {
  const ticket = notes.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket inconnu' });
  notes.remove(ticket.id);
  // Les conversations de l'équipe survivent : elles portent du travail. Seul le fil rouge
  // entre elles disparaît, faute de ticket à relier.
  team.forget(ticket.id);
  broadcastNotes(ticket.project);
  res.json({ deleted: true });
});

// --- Une équipe sur un ticket ----------------------------------------------
//
// Trois conversations enchaînées : planifier, coder, relire. Voir `lib/team.js` pour le
// pourquoi de chaque étape ; ici, ce qui les crée et les fait se suivre.

/** Dernière réponse d'un agent dans une conversation — ce que l'étape suivante reçoit. */
function lastAgentText(convId) {
  const conv = store.get(convId);
  if (!conv) return '';
  const texts = (conv.items || []).filter((i) => i.kind === 'text' && i.text);
  return texts.length ? String(texts[texts.length - 1].text) : '';
}

/**
 * Crée la conversation d'une étape et lance son turn.
 *
 * Les conversations s'enchaînent par `parentId` : la sidebar les imbrique alors comme un
 * relais, et on lit l'équipe d'un coup d'œil au lieu de trois lignes sans rapport.
 */
async function startTeamStage(run, stage, ticket) {
  const previous = team.KEYS.slice(0, team.KEYS.indexOf(stage)).map((k) => run.convs[k]).filter(Boolean);
  const parentId = previous.length ? previous[previous.length - 1] : null;
  const provider = stage === 'review' ? run.reviewer : run.provider;

  const conv = store.create({
    provider,
    cwd: run.project,
    folder: (store.folderForCwd(run.project) || {}).id || null,
    parentId,
    title: `${team.labelOf(stage)} — ${run.ticketTitle}`,
    titleAuto: false, // le titre dit l'étape : le laisser réécrire perdrait le fil rouge
  });

  // Seul le codeur est isolé. Sur un projet sans git, il travaille en direct — l'isolation
  // est un confort, pas une condition.
  let branch = null;
  if (team.isolates(stage)) {
    try {
      const wt = await worktrees.create({ convId: conv.id, cwd: run.project });
      store.update(conv.id, { cwd: wt.path, worktree: wt });
      conv.cwd = wt.path;
      conv.worktree = wt;
      branch = wt.branch;
      team.update(run.id, { branch: wt.branch, base: wt.base });
    } catch (err) {
      const item = store.addItem(conv.id, {
        kind: 'notice',
        text: `Pas d'isolation pour cette étape : ${err.message}`,
      });
      if (item) broadcast({ type: 'item', convId: conv.id, item });
    }
  }

  team.attach(run.id, stage, conv.id);
  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === conv.id) });
  broadcast({ type: 'folders', folders: store.folders() });

  const prompt =
    stage === 'plan'
      ? team.planPrompt(ticket)
      : stage === 'build'
        ? team.buildPrompt(ticket, lastAgentText(run.convs.plan), branch)
        : team.reviewPrompt(ticket, run.branch || null, run.base || null);

  await dispatch(conv, prompt, null, { teamStage: stage });
  return conv;
}

/**
 * Une étape vient de finir : enchaîner, conclure, ou s'arrêter.
 *
 * Ne lance jamais : appelée depuis `onExit`, hors de toute requête HTTP, il n'y a personne
 * pour recevoir un rejet. Ce qui rate est écrit dans le fil.
 */
async function advanceTeam(run, stage, outcome) {
  const decision = team.next(stage, outcome);
  const ticket = notes.get(run.ticketId) || {
    id: run.ticketId,
    title: run.ticketTitle,
    body: '',
  };

  if (decision.action === 'stop') {
    team.update(run.id, { status: 'stopped', stoppedWhy: decision.why, endedAt: new Date().toISOString() });
    const item = store.addItem(run.convs[stage], {
      kind: 'notice',
      text: `Équipe arrêtée : ${decision.why}. Les étapes suivantes n'ont pas été lancées.`,
    });
    if (item) broadcast({ type: 'item', convId: run.convs[stage], item });
    broadcast({ type: 'notes', project: run.project, tickets: notes.list(run.project) });
    return;
  }

  if (decision.action === 'finish') {
    team.update(run.id, { status: 'done', endedAt: new Date().toISOString() });
    const item = store.addItem(run.convs[stage], {
      kind: 'notice',
      text: `Équipe terminée sur « ${run.ticketTitle} ». Le ticket reste à toi : c'est à la relecture ci-dessus de te dire si on peut le fermer.`,
    });
    if (item) broadcast({ type: 'item', convId: run.convs[stage], item });
    broadcast({ type: 'notes', project: run.project, tickets: notes.list(run.project) });
    return;
  }

  await startTeamStage(team.get(run.id), decision.stage, ticket);
}

app.post('/api/notes/:id/team', asyncRoute(async (req, res) => {
  const ticket = notes.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket inconnu' });

  const running = team.list(ticket.project).find((r) => r.status === 'running');
  if (running) {
    return res.status(409).json({ error: 'Une équipe travaille déjà sur ce projet.' });
  }

  const provider = PROVIDERS.has((req.body || {}).provider) ? req.body.provider : 'claude';
  const asked = (req.body || {}).reviewer;
  const run = team.open({
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    project: ticket.project,
    provider,
    reviewer: PROVIDERS.has(asked) ? asked : team.reviewerFor(provider),
  });

  try {
    await startTeamStage(run, 'plan', ticket);
  } catch (err) {
    team.update(run.id, { status: 'stopped', stoppedWhy: err.message });
    return res.status(500).json({ error: err.message });
  }
  // Le ticket passe en cours : une équipe dessus, c'est exactement ce que « en cours » veut
  // dire, et l'oublier laisserait la colonne « à faire » mentir.
  notes.update(ticket.id, { status: 'doing' });
  broadcast({ type: 'notes', project: ticket.project, tickets: notes.list(ticket.project) });
  res.status(201).json({ run: team.get(run.id) });
}));

app.get('/api/notes/:id/team', (req, res) => {
  const ticket = notes.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket inconnu' });
  const runs = team.list(ticket.project).filter((r) => r.ticketId === ticket.id);
  res.json({ run: runs.length ? runs[runs.length - 1] : null, stages: team.STAGES });
});

/** Le ticket transformé en consigne, pour les deux boutons « Prompt » de l'interface. */
app.get('/api/notes/:id/prompt', (req, res) => {
  const ticket = notes.get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket inconnu' });
  res.json({ ticket, prompt: notes.promptText(ticket) });
});

// --- Plans et schémas d'un projet ------------------------------------------
//
// Ces routes servent des **fichiers du projet**, pas de l'état de l'application : voir
// l'en-tête de `lib/plans.js` pour la raison de ne rien recopier dans `data/`.
//
// Deux conséquences visibles ici. Le projet se désigne comme pour le bloc-notes — par la
// conversation, ou directement. Et il n'y a **pas de route de suppression** : ces fichiers
// appartiennent au projet, et une application sans authentification n'a pas à savoir effacer
// le `README.md` d'un dépôt.

/** Projet visé par une requête. Même forme que `notesProject`, sur la clé de `plans`. */
registerPlanRoutes({
  app,
  store,
  plans,
  broadcast,
});

// --- Réglages -------------------------------------------------------------
//
// Quatre sections seulement, et pas un miroir de `config/`. Ce qui manque à l'appel est
// délibéré : `pricing.json` et `models.json` sont des relevés datés, pas des préférences.
// Voir l'en-tête de `lib/settings.js`.

// --- État du serveur -------------------------------------------------------
//
// Rien n'est calculé ici : tout vient d'adminPanel, qui sait déjà le faire. Voir `lib/panel.js`
// pour la raison de ne pas fusionner les deux applications.

app.get('/api/panel', asyncRoute(async (req, res) => {
  // `webUrl` est rendu même sans jeton : le lien vers le panneau doit marcher avant qu'on ait
  // configuré quoi que ce soit — c'est justement là qu'on a besoin d'y aller.
  const common = { base: panel.BASE, webUrl: panel.WEB_URL };
  if (!panel.available()) {
    return res.json({ available: false, ...common, tokenFile: panel.TOKEN_FILE });
  }
  res.json({ available: true, ...common, ...(await panel.overview()) });
}));

// --- Règles d'un projet ----------------------------------------------------
//
// Le projet se désigne comme pour le bloc-notes : directement, ou par la conversation d'où
// l'on parle — c'est cette seconde forme que les agents utilisent, ne connaissant qu'eux-mêmes.

registerProjectKnowledgeRoutes({
  app,
  store,
  notes,
  rules,
  memory,
  prompts,
  settings,
  fs,
  path,
  broadcast,
});
registerSettingsRoutes({
  app,
  asyncRoute,
  settings,
  checks: createSettingsChecks({
    notify,
    mail,
    browserMcp,
    host: HOST,
    port: PORT,
  }),
});

app.get('/api/projects', (req, res) => {
  res.json(projects.listGroups());
});

app.post('/api/projects', (req, res) => {
  const { parent, name } = req.body || {};
  try {
    res.status(201).json({ project: projects.createFolder(parent, name) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/models', (req, res) => {
  try {
    const models = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    // Grok publie sa liste. Le fichier ne sert que de repli si la commande échoue :
    // un relevé daté a déjà laissé l'interface sur grok-4.5 après la sortie de 4.7.
    const liveGrok = grokCatalog.current();
    const source = liveGrok ? { ...models, grok: liveGrok.models } : models;
    const enriched = modelSelection.enrichModels(source, liveGrok);
    // Générique : ajouter un provider dans models.json suffit, pas besoin de le
    // nommer ici. Les clés `_…` sont de la documentation interne au fichier.
    // `browsable` : qui peut recevoir un navigateur pour une conversation donnée. Vide
    // quand le service MCP n'est pas configuré — l'option disparaît alors de l'UI plutôt
    // que d'échouer au premier clic.
    const out = {
      efforts: modelSelection.enrichEfforts(models.efforts),
      forkable: [],
      // Qui sait FIGER une session, ce qui n'est pas la meme chose que la deriver : la
      // planification d'un message s'en sert pour dire si le contexte sera gele ou seulement
      // isole.
      freezable: [],
      // Qui accepte `/compact` en mode non-interactif (Claude, Grok). Codex : pas d'équivalent.
      compactable: [],
      browsable: [],
      browserAlways: [],
      // Un défaut de tarification n'est pas un défaut d'exécution. Seul Grok expose ici
      // un modèle résolu, car son CLI fournit un catalogue vérifiable.
      defaults: modelSelection.defaults(liveGrok),
    };
    for (const [key, value] of Object.entries(enriched)) {
      if (!key.startsWith('_') && key !== 'efforts' && Array.isArray(value)) {
        out[key] = value;
        // Qui sait forker une session : le relais s'en sert pour n'offrir la reprise
        // de contexte que là où elle est possible.
        if (canFork(key)) out.forkable.push(key);
        if (sessions.supports(key)) out.freezable.push(key);
        if (contextActions.supportsCompact(key)) out.compactable.push(key);
        if (browserMcp.supports(key)) out.browsable.push(key);
        if (browserMcp.alwaysOn(key)) out.browserAlways.push(key);
      }
    }
    if (liveGrok) {
      out.efforts = {
        ...(out.efforts || {}),
        grok: modelSelection.enrichEfforts({ grok: liveGrok.efforts }).grok,
      };
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: `models.json illisible : ${err.message}` });
  }
});

/**
 * Catalogue des skills d'un fournisseur.
 *
 * Il n'y a rien à exécuter côté serveur : une skill s'invoque en écrivant `/nom` dans le
 * message, et le CLI s'en charge. Cet endpoint ne sert qu'à savoir ce qui existe.
 */
app.get('/api/skills', (req, res) => {
  const provider = req.query.provider || 'claude';
  if (!PROVIDERS.has(provider)) {
    return res.status(400).json({ error: `Provider inconnu : ${provider}` });
  }
  res.json(skills.list(provider));
});

/**
 * Ce qui est sur disque, avec sa portée. Question différente de `/api/skills`, qui dit ce
 * qu'on peut taper : ici on dit ce qu'on peut déplacer.
 */
app.get('/api/skills/inventory', (req, res) => {
  res.json(skills.inventory(req.query.cwd || null));
});

// --- Atelier des skills ---------------------------------------------------
//
// Un chat qui écrit et modifie les skills à la place de l'utilisateur. Le turn est un turn hors
// fil (`oneShotTurn`) : il n'a pas de conversation, et il n'a pas besoin d'en avoir une — ce
// qu'il produit, ce sont des fichiers sur disque, pas un fil à relire.
//
// Ce qu'il fait passe donc par deux canaux, et c'est voulu : le direct par websocket, pour voir
// l'agent travailler, et l'inventaire renvoyé à la fin, qui est la seule vérité — c'est le
// disque qui dit ce qui existe.

/** Un seul turn d'atelier à la fois : ils écriraient dans le même dossier. */
let atelierRun = null;

app.get('/api/skills/chat', (req, res) => {
  res.json({ ...atelier.state(), running: Boolean(atelierRun) });
});

app.post('/api/skills/chat', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const provider = body.provider || 'claude';
  if (!PROVIDERS.has(provider)) {
    return res.status(400).json({ error: `Provider inconnu : ${provider}` });
  }
  const message = String(body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Message vide' });
  if (atelierRun) return res.status(409).json({ error: "L'atelier travaille déjà." });

  const cwd = body.cwd || null;
  if (cwd && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
    return res.status(400).json({ error: `Dossier introuvable : ${cwd}` });
  }

  const inventory = skills.inventory(cwd);
  // Le dossier des skills globales peut ne pas exister encore — sur une installation neuve,
  // c'est même le cas normal. Le créer maintenant évite un agent qui échoue sur un `cd`.
  fs.mkdirSync(inventory.globalRoot, { recursive: true });

  // Relevé avant d'y ajouter la demande : le rappel doit porter les échanges précédents, pas
  // celui qui est en train de se faire.
  const earlier = atelier.state().messages;
  const messages = atelier.remember('user', message);
  broadcast({ type: 'atelier', phase: 'start', provider, messages });

  atelierRun = {};
  const sessionId = atelier.resumable(provider);
  const outcome = await oneShotTurn({
    id: atelier.ID,
    provider,
    // Le dossier de travail sert de point de départ à l'agent ; il écrit de toute façon aux
    // chemins absolus que la consigne lui donne. Avec un projet choisi, c'est le sien : une
    // skill de portée projet vit dedans.
    cwd: cwd || inventory.globalRoot,
    prompt: atelier.buildPrompt({ message, inventory, messages: earlier }),
    sessionId,
    sessionStarted: Boolean(sessionId),
    onSession: (id) => atelier.keepSession(provider, id),
    onDelta: (text, kind) => broadcast({ type: 'atelier', phase: 'delta', text, kind }),
    onTool: (item) =>
      broadcast({ type: 'atelier', phase: 'tool', tool: item.tool, input: item.input }),
    onStart: (child) => {
      atelierRun = { child };
    },
  });
  atelierRun = null;

  const reply =
    outcome.text ||
    (outcome.failed
      ? `L'atelier n'a rien pu faire : ${outcome.stderr || 'le turn a échoué'}`
      : "L'agent n'a rien répondu.");
  const after = atelier.remember('assistant', reply);

  // Les descriptions sont en cache, et l'agent vient peut-être d'en réécrire une.
  skills.forgetDescriptions();
  broadcast({ type: 'skills' });
  broadcast({ type: 'atelier', phase: 'end', messages: after });

  res.json({
    reply,
    failed: outcome.failed,
    messages: after,
    // Le disque fait foi : on renvoie ce qu'il contient maintenant, sans croire l'agent sur
    // parole quant à ce qu'il a écrit.
    inventory: skills.inventory(cwd),
  });
}));

/** Interrompt le turn de l'atelier. Ce qui a déjà été écrit sur disque y reste. */
app.post('/api/skills/chat/stop', (req, res) => {
  if (!atelierRun || !atelierRun.child) {
    return res.status(409).json({ error: 'Aucun turn en cours dans l’atelier' });
  }
  killTree(atelierRun.child);
  res.json({ stopped: true });
});

/** Oublie le fil et la session. Les skills écrites, elles, restent sur disque. */
app.delete('/api/skills/chat', (req, res) => {
  if (atelierRun) return res.status(409).json({ error: "L'atelier travaille : attends la fin." });
  const fresh = atelier.reset();
  broadcast({ type: 'atelier', phase: 'reset', messages: fresh.messages });
  res.json(fresh);
});

app.post('/api/skills', (req, res) => {
  const done = skills.create(req.body || {});
  if (done.error) return res.status(400).json({ error: done.error });
  broadcast({ type: 'skills' });
  res.status(201).json({ ...done, inventory: skills.inventory((req.body || {}).cwd || null) });
});

app.post('/api/skills/:name/move', (req, res) => {
  const { from, to, cwd } = req.body || {};
  const done = skills.move(req.params.name, from, to, cwd || null);
  if (done.error) return res.status(400).json({ error: done.error });
  broadcast({ type: 'skills' });
  res.json({ ...done, inventory: skills.inventory(cwd || null) });
});

app.delete('/api/skills/:name', (req, res) => {
  const done = skills.remove(req.params.name, req.query.scope || 'global', req.query.cwd || null);
  if (done.error) return res.status(400).json({ error: done.error });
  broadcast({ type: 'skills' });
  res.json({ ...done, inventory: skills.inventory(req.query.cwd || null) });
});

app.get('/api/limits', (req, res) => {
  const provider = req.query.provider || 'claude';
  if (!PROVIDERS.has(provider)) {
    return res.status(400).json({ error: `Provider inconnu : ${provider}` });
  }
  res.json(limits.get(provider, req.query.force === '1'));
});

app.get('/api/usage', (req, res) => {
  const month = req.query.month || 'all';
  if (month !== 'all' && !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Mois attendu au format YYYY-MM' });
  }
  // Le journal ne connaît que des identifiants de conversation. Le projet et le titre se
  // résolvent ici, où le magasin est à portée — et `projectOf` replie une conversation isolée
  // sur son dépôt, sinon chaque branche compterait comme un projet à elle.
  const resolve = (convId) => {
    const conv = store.get(convId);
    if (!conv) return null;
    return { project: notes.projectOf(conv), title: conv.title, provider: conv.provider };
  };
  res.json({ ...usage.summary(month), ...usage.dashboard({ month, resolve }) });
});

// --- Galerie ---------------------------------------------------------------
//
// Indépendante des conversations : une génération ne crée pas de conversation et
// n'apparaît nulle part dans la sidebar. On lance un turn dans le dossier du projet, et
// on regarde ce qui est apparu — c'est ce qui permet de traiter pareil un modèle d'image
// et un agent qui écrit un SVG.

const GENERATION_TIMEOUT_MS = 10 * 60_000;

/** Une génération : un turn, un fichier attendu, aucune trace ailleurs. */
function generateImage(project, prompt, provider, model, batchId) {
  const image = gallery.startImage({
    projectId: project.id,
    prompt,
    provider,
    model,
    batchId,
  });
  // Un dossier vide par génération : lancés en parallèle sur la même description, deux
  // agents se marchaient dessus et le résultat de l'un était attribué à l'autre.
  const workDir = gallery.prepareGen(project.id, image.id);
  broadcast({ type: 'gallery', image });

  // Objet minimal attendu par le runner. Claude et Grok veulent un identifiant de
  // session valide ; celui de l'image en est un.
  const conv = {
    id: image.id,
    provider,
    cwd: workDir,
    model: model || null,
    effort: null,
    sessionStarted: false,
    providerSessionId: provider === 'codex' ? null : image.id,
    forkFrom: null,
  };

  let said = '';
  let failed = null;
  let child = null;

  const done = (patch) => {
    const updated = gallery.finishImage(image.id, patch);
    if (updated) broadcast({ type: 'gallery', image: updated });
  };

  const handlers = {
    onSession() {},
    onDelta() {},
    onToolResult() {},
    onItem(item) {
      if (item.kind === 'text' && item.text) said = item.text;
      if (item.kind === 'result') {
        if (item.isError) failed = item.text || 'Échec de la génération';
        usage.record({
          provider,
          convId: image.id,
          item,
          fallbackModel: model,
        });
        if (item.costUsd) gallery.finishImage(image.id, { costUsd: item.costUsd });
      }
      return null;
    },
    onExit(code, stderr, fatal) {
      clearTimeout(timer);
      const file = gallery.collectGen(project.id, image.id);
      if (file) {
        return done({
          state: 'done',
          file,
          text: said.trim().slice(0, 400) || null,
          error: null,
        });
      }
      done({
        state: 'failed',
        error:
          failed ||
          (fatal || code !== 0
            ? stderr || `L'agent s'est arrêté avec le code ${code}`
            : "L'agent n'a produit aucun fichier image."),
        text: said.trim().slice(0, 400) || null,
      });
    },
  };

  const timer = setTimeout(() => {
    if (child) killTree(child);
  }, GENERATION_TIMEOUT_MS);
  if (timer.unref) timer.unref();

  try {
    child = runTurn(conv, gallery.buildPrompt(prompt), handlers, null);
  } catch (err) {
    clearTimeout(timer);
    done({ state: 'failed', error: err.message });
  }
  return image;
}

app.get('/api/gallery', (req, res) => {
  res.json({ projects: gallery.projects() });
});

app.post('/api/gallery/projects', (req, res) => {
  try {
    const project = gallery.createProject((req.body || {}).name);
    broadcast({ type: 'gallery-projects', projects: gallery.projects() });
    res.status(201).json({ project });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/gallery/projects/:id', (req, res) => {
  try {
    const project = gallery.renameProject(req.params.id, (req.body || {}).name);
    if (!project) return res.status(404).json({ error: 'Projet introuvable' });
    broadcast({ type: 'gallery-projects', projects: gallery.projects() });
    res.json({ project });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/gallery/projects/:id', (req, res) => {
  if (!gallery.removeProject(req.params.id)) {
    return res.status(404).json({ error: 'Projet introuvable' });
  }
  broadcast({ type: 'gallery-projects', projects: gallery.projects() });
  res.json({ deleted: true });
});

app.get('/api/gallery/projects/:id/images', (req, res) => {
  if (!gallery.getProject(req.params.id)) {
    return res.status(404).json({ error: 'Projet introuvable' });
  }
  res.json({ images: gallery.images(req.params.id) });
});

app.post('/api/gallery/projects/:id/generate', asyncRoute(async (req, res) => {
  const project = gallery.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Projet introuvable' });

  const { model } = req.body || {};
  const prompt = ((req.body && req.body.prompt) || '').trim();
  const wanted = Array.isArray((req.body || {}).providers) ? req.body.providers : [];

  if (!prompt) return res.status(400).json({ error: 'Description vide' });
  const providers = wanted.filter((p) => PROVIDERS.has(p));
  if (!providers.length) return res.status(400).json({ error: 'Aucun agent sélectionné' });

  // Un agent auquel on n'est pas connecté ne peut rien produire : on le dit avant de
  // lancer, plutôt que de laisser trois emplacements échouer un par un.
  const usable = [];
  for (const p of providers) {
    if (accounts.isUsable(await accounts.get(p))) usable.push(p);
  }
  if (!usable.length) {
    return res.status(409).json({ error: 'Aucun des agents choisis n\'est connecté' });
  }

  // Un lot : même description, plusieurs agents, comparables entre eux.
  const batchId = require('crypto').randomUUID();
  const started = usable.map((p) => generateImage(project, prompt, p, model, batchId));
  res.status(201).json({ batchId, images: started, skipped: providers.filter((p) => !usable.includes(p)) });
}));

app.delete('/api/gallery/images/:id', (req, res) => {
  if (!gallery.removeImage(req.params.id)) {
    return res.status(404).json({ error: 'Image introuvable' });
  }
  res.json({ deleted: true });
});

app.get('/api/gallery/images/:id/file', (req, res) => {
  const file = gallery.resolveFile(gallery.getImage(req.params.id));
  if (!file) return res.status(404).json({ error: 'Image introuvable' });
  res.sendFile(file, { maxAge: '1h' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.get('/api/conversations', (req, res) => {
  res.json({ conversations: store.list(), folders: store.folders() });
});

/**
 * Recherche dans le contenu des messages. Le filtre instantané de la sidebar couvre déjà
 * le titre et le dossier ; celle-ci va voir dans les fils, ce qui demande de lire le
 * disque et ne peut donc pas partir à chaque frappe — le client attend une pause.
 */
app.get('/api/search', asyncRoute(async (req, res) => {
  const { provider, project, status, archived, from, to, kind } = req.query;
  const conversations = store.list().filter((conv) => {
    if (archived === 'only' ? !conv.archived : archived !== 'include' && conv.archived) return false;
    if (provider && conv.provider !== provider) return false;
    if (project && workspaceModule.projectKey(conv.project) !== workspaceModule.projectKey(project)) return false;
    if (status && conv.status !== status) return false;
    if (from && String(conv.updatedAt).slice(0, 10) < from) return false;
    if (to && String(conv.createdAt).slice(0, 10) > to) return false;
    return true;
  });
  const result = await searchService.search(req.query.q, conversations, { from, to, kind });
  res.json({ ...result, conversations, scanned: conversations.length });
}));

// --- Dossiers de la sidebar ----------------------------------------------

registerFolderRoutes({
  app,
  store,
  secrets,
  broadcast,
});

// --- Déclencheurs ---------------------------------------------------------
//
// Un déclencheur lance un agent à heure fixe sur un dossier. Il existe indépendamment
// de ses exécutions : le désactiver, le modifier ou le supprimer ne touche pas aux
// conversations qu'il a déjà produites.

function checkTriggerCwd(cwd) {
  try {
    return fs.statSync(cwd).isDirectory() ? null : `Ce n'est pas un dossier : ${cwd}`;
  } catch {
    return `Dossier introuvable : ${cwd}`;
  }
}

/**
 * Interrompt le turn en cours d'une conversation, s'il y en a un.
 *
 * `forget` retire l'entrée de la table des turns. C'est ce qu'il faut avant de supprimer
 * la conversation, mais surtout pas pour une simple interruption : sans l'entrée, `onExit`
 * ignorerait que l'arrêt était volontaire, repeindrait l'interruption en erreur et
 * ajouterait un « arrêté avec le code null » qui masque la vraie raison.
 */
function stopConversation(id, options) {
  const entry = running.get(id);
  if (!entry) return false;
  entry.stopped = true;
  if (entry.preparing) {
    setStatus(id, 'stopped');
    if ((store.get(id) || {}).goal) setGoal(id, null);
  }
  const ask = asks.pendingFor(id);
  if (ask && ask.mode === 'live') {
    const expired = asks.expire(ask.id);
    if (expired) broadcast({ type: 'ask-answered', ask: expired });
  }
  if (entry.child) killTree(entry.child);
  if (options && options.forget) running.delete(id);
  return true;
}

/**
 * Lance une exécution de déclencheur. C'est une conversation ordinaire — relisible,
 * relayable, avec ses instantanés et son coût — rangée dans le dossier du déclencheur.
 */
/**
 * @param {object} trigger
 * @param {{prompt?: string}} [options] `prompt` remplace la consigne du déclencheur — c'est
 *   ce que fait un webhook, qui y ajoute la charge reçue en contexte borné.
 */
async function runTrigger(trigger, options) {
  const startedAt = new Date();
  const conv = store.create({
    provider: trigger.provider,
    cwd: trigger.cwd,
    model: trigger.model,
    effort: trigger.effort,
    folder: trigger.folder,
    triggerId: trigger.id,
    title: `${trigger.name} — ${startedAt.toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    })}`,
  });
  store.updateTrigger(trigger.id, {
    lastRunAt: startedAt.toISOString(),
    lastStatus: 'working',
    lastConvId: conv.id,
  });
  runs.start({
    convId: conv.id,
    triggerId: trigger.id,
    title: conv.title,
    startedAt: startedAt.toISOString(),
  });
  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === conv.id) });
  broadcast({ type: 'triggers', triggers: store.triggers() });

  // Dossier de travail disparu : l'exécution échoue visiblement, avec une conversation
  // qui porte l'erreur, plutôt que de lancer un agent dans un dossier inattendu.
  const cwdError = checkTriggerCwd(trigger.cwd);
  if (cwdError) {
    const item = store.addItem(conv.id, { kind: 'result', isError: true, text: cwdError });
    broadcast({ type: 'item', convId: conv.id, item });
    setStatus(conv.id, 'error');
    store.updateTrigger(trigger.id, { lastStatus: 'error' });
    runs.finish(conv.id, { status: 'error', error: cwdError });
    broadcast({ type: 'triggers', triggers: store.triggers() });
    return conv;
  }

  await dispatch(conv, (options && options.prompt) || trigger.prompt, null);

  // Durée maximale : on réutilise le mécanisme d'interruption de `/stop`, qui tue le
  // groupe de process. Le minuteur est désarmé à la fin du turn.
  if (trigger.killAfterMinutes) {
    const timer = setTimeout(() => {
      killTimers.delete(conv.id);
      if (!running.has(conv.id)) return;
      // La raison est posée avant l'arrêt : c'est `onExit` qui conclut le statut, et il ne
      // dit rien de plus qu'« interrompu ».
      const item = store.addItem(conv.id, {
        kind: 'result',
        isError: true,
        text: `Exécution interrompue après ${trigger.killAfterMinutes} min : durée maximale du déclencheur.`,
      });
      broadcast({ type: 'item', convId: conv.id, item });
      stopConversation(conv.id);
    }, trigger.killAfterMinutes * 60_000);
    if (timer.unref) timer.unref();
    killTimers.set(conv.id, timer);
  }

  return conv;
}

/**
 * Nombre d'exécutions renvoyées par déclencheur. Assez pour voir une série d'échecs, pas
 * assez pour peser sur une vue qui se recharge à chaque tick du planificateur.
 */
const RUNS_SHOWN = 20;

/**
 * Rédige le rapport d'une exécution, puis l'envoie.
 *
 * Le rapport est un **second turn dans la même conversation** : l'agent garde tout son
 * contexte, ce qu'aucune autre approche ne donne. Le demander dans la consigne initiale
 * coûterait moins cher mais vaudrait moins : il serait rédigé avant que l'agent sache
 * comment son travail se termine.
 *
 * Ne lance jamais : une exécution qui a réussi ne doit pas être requalifiée en échec parce
 * que son rapport n'est pas parti. Ce qui rate est écrit dans le fil, là où on le verra.
 */
/**
 * Tire une leçon d'un turn qui s'est cogné, et la propose.
 *
 * Un second turn **dans la même conversation** : il a tout le contexte sous les yeux, il n'a
 * rien à relire, et sa consigne lui interdit de toucher à quoi que ce soit. C'est la même
 * mécanique que le rapport de fin et que la vérification du mode objectif, pour la même
 * raison — ce qu'on veut savoir n'existe pas encore quand le travail commence.
 *
 * Ne lance jamais : appelée depuis `onExit`, hors de toute requête HTTP.
 */
async function proposeLesson(conv, outcome) {
  const config = settings.read('memory');
  if (!config || !config.enabled) return null;

  const project = notes.projectOf(conv);
  const fresh = store.get(conv.id) || conv;
  if (
    !memory.worthAsking({
      outcome,
      project,
      items: fresh.items || [],
      pending: Boolean(memory.pendingFor(conv.id)),
    })
  ) {
    return null;
  }

  // La demande rejoint le fil, repliée : le turn a eu lieu et il a coûté quelque chose. Le
  // cacher rendrait la conversation trompeuse et le journal de consommation inexplicable.
  const request = store.addItem(conv.id, {
    kind: 'user',
    text: memory.EXTRACT_PROMPT,
    memory: 'request',
  });
  if (request) broadcast({ type: 'item', convId: conv.id, item: request });

  const result = await startTurn(conv, memory.EXTRACT_PROMPT, [], {
    schema: memory.EXTRACT_SCHEMA,
    isMemory: true,
  });

  const found = result && result.structured;
  // « Non » est la réponse attendue la plupart du temps, et c'est ce refus qui garde la
  // mémoire lisible : rien à signaler dans le fil, on n'a rien appris.
  if (!found || !found.worth || !found.title || !found.lesson) return null;

  let row;
  try {
    row = memory.propose({ project, convId: conv.id, title: found.title, lesson: found.lesson });
  } catch {
    return null; // titre ou leçon vides malgré le schéma : rien à proposer
  }

  const notice = store.addItem(conv.id, {
    kind: 'notice',
    text: `Leçon à garder pour ce projet : ${row.title}`,
    memoryId: row.id,
  });
  if (notice) broadcast({ type: 'item', convId: conv.id, item: notice });
  broadcast({ type: 'memory', project, entries: memory.list(project) });
  return row;
}

async function produceReport(conv, trigger) {
  const notifyDone = (extra) =>
    notify
      .send({
        conv: store.get(conv.id) || conv,
        outcome: 'done',
        error: null,
        mode: trigger.notify,
        triggerName: trigger.name,
        appUrl: APP_URL,
        ...extra,
      })
      .catch((err) => console.error(`notification : ${err.message}`));

  const notice = (text) => {
    const item = store.addItem(conv.id, { kind: 'notice', text });
    if (item) broadcast({ type: 'item', convId: conv.id, item });
  };

  const prompt = report.buildPrompt(trigger.reportSpec);
  // La demande rejoint le fil, comme celle d'une note de passation : le turn a bien eu
  // lieu et il a coûté quelque chose, le cacher rendrait la conversation trompeuse. Elle
  // est repliée à l'affichage, la consigne étant longue et toujours la même.
  //
  // Pas d'instantané avant ce turn, contrairement à un message ordinaire : le prompt
  // interdit de rien modifier, et celui pris avant le travail reste le bon point de retour.
  const request = store.addItem(conv.id, { kind: 'user', text: prompt, report: 'request' });
  if (request) broadcast({ type: 'item', convId: conv.id, item: request });

  let outcome;
  try {
    outcome = await startTurn(conv, prompt, [], {
      schema: report.SCHEMA,
      isReport: true,
    });
  } catch (err) {
    notice(`Rapport non rédigé : ${err.message}`);
    await notifyDone();
    return null;
  }

  const written = report.normalize(outcome.structured);
  if (!written) {
    // Le schéma garantit la forme, pas le fond : un corps vide passe la validation.
    notice(
      outcome.failed
        ? "Le rapport n'a pas pu être rédigé : le turn a échoué. Le travail, lui, a abouti."
        : "Le rapport est revenu vide. Le travail, lui, a abouti."
    );
    await notifyDone();
    return null;
  }

  runs.attachReport(conv.id, written);
  broadcast({ type: 'triggers', triggers: store.triggers() });

  if (trigger.reportEmail || mail.available()) {
    const message = report.buildMail({
      report: written,
      triggerName: trigger.name,
      conv: store.get(conv.id) || conv,
      appUrl: APP_URL,
    });
    const sent = await mail.send({ ...message, to: trigger.reportEmail });
    notice(sent.sent ? `Rapport envoyé à ${sent.to}.` : `Rapport non envoyé : ${sent.reason}.`);
  }

  await notifyDone();
  return written;
}

// --- Mode objectif --------------------------------------------------------
//
// La décision — vérifier, relancer, conclure — est dans `lib/goal.js`, hors du serveur et
// prouvée par des tests : une boucle qui ne s'arrête pas ne se voit pas en la relisant. Il ne
// reste ici que l'exécution de décisions déjà prises.

/**
 * Notification de fin de travail.
 *
 * Sortie de `onExit` parce que la boucle d'objectif la déclenche plus tard, depuis son propre
 * enchaînement : deux appels différents à la même chose finissent toujours par diverger.
 */
function notifyEnd({ conv, trigger, outcome, error }) {
  notify
    .send({
      conv,
      outcome,
      error: error || null,
      mode: trigger ? trigger.notify : 'inherit',
      triggerName: trigger ? trigger.name : null,
      appUrl: APP_URL,
    })
    .catch((err) => console.error(`notification : ${err.message}`));
}

/** L'objectif d'une conversation, ou son abandon. Diffusé : le bandeau s'affiche partout. */
function setGoal(convId, goal) {
  const updated = store.update(convId, { goal: goal || null });
  broadcast({ type: 'goal', convId, goal: goal || null });
  return updated;
}

/**
 * Poursuit un objectif après un turn qui vient de finir : vérifie, puis relance ou conclut.
 *
 * Ne lance jamais : ce qui rate est écrit dans le fil, et la boucle rend la main plutôt que de
 * tourner sur une erreur. Le cas dangereux n'est pas l'échec, c'est la relance à l'aveugle.
 */
async function pursueGoal(conv, trigger, outcome, stderr) {
  const notice = (text) => {
    const item = store.addItem(conv.id, { kind: 'notice', text });
    if (item) broadcast({ type: 'item', convId: conv.id, item });
  };

  const goal = conv.goal;
  let decision = goals.decide(goal, outcome);
  if (!decision) return null;
  let check = null;

  if (decision.action === 'check') {
    // Vérification : un turn dans la même conversation, donc avec tout le contexte du travail
    // qu'il juge. La demande rejoint le fil — elle a coûté un turn, la cacher rendrait la
    // conversation trompeuse — mais repliée, comme celle du rapport.
    const prompt = goals.buildCheckPrompt(goal.text);
    const request = store.addItem(conv.id, { kind: 'user', text: prompt, goal: 'check' });
    if (request) broadcast({ type: 'item', convId: conv.id, item: request });

    let result;
    try {
      result = await startTurn(conv, prompt, [], { schema: goals.SCHEMA, isGoalCheck: true });
    } catch (err) {
      notice(`Vérification de l’objectif impossible : ${err.message}`);
      result = { stopped: false, failed: true, structured: null };
    }
    check = goals.normalize(result.structured);
    decision = goals.decide(
      goal,
      result.stopped ? 'stopped' : result.failed ? 'error' : 'done',
      check
    );
  }

  // Abandonné à la main pendant la vérification : sa décision passe avant la nôtre.
  const fresh = store.get(conv.id) || conv;
  if (!fresh.goal) return null;

  if (decision.action === 'continue') {
    const next = { ...goal, round: decision.round };
    setGoal(conv.id, next);
    notice(
      `Objectif non atteint — tour ${decision.round} sur ${goal.max}. Reste : ${check.remaining}`
    );
    const prompt = goals.buildContinuePrompt(next, check);
    // Un message envoyé à la main juste après la vérification a pu démarrer un turn : la
    // relance prend alors la file, plutôt que d'en lancer un second en parallèle.
    if (running.has(conv.id)) enqueue(fresh, prompt, null);
    else await dispatch(fresh, prompt, null, { goal: 'continue' });
    return decision;
  }

  setGoal(conv.id, null);

  if (decision.action === 'reached') {
    notice(`Objectif atteint${check && check.summary ? ` — ${check.summary}` : ''}.`);
    // Le travail est vraiment fini : c'est maintenant que le rapport d'un déclencheur a un
    // sens, et pas à la fin du premier turn.
    if (trigger && trigger.report && outcome === 'done') {
      await produceReport(store.get(conv.id) || fresh, trigger);
      return decision;
    }
    notifyEnd({ conv: store.get(conv.id) || fresh, trigger, outcome: 'done', error: null });
    return decision;
  }

  if (decision.action === 'exhausted') {
    const text =
      `Objectif non atteint après ${goal.max} tour${goal.max > 1 ? 's' : ''} : la boucle ` +
      `s’arrête là, comme prévu. Reste : ${check.remaining}`;
    notice(text);
    // Prévenu comme un échec, parce que c'en est un du point de vue de la demande : l'objectif
    // était le contrat, et il n'est pas rempli.
    notifyEnd({ conv: store.get(conv.id) || fresh, trigger, outcome: 'error', error: text });
    return decision;
  }

  // Abandon : turn interrompu, en échec, ou vérification illisible.
  notice(`Mode objectif arrêté : ${decision.reason}. L’objectif reste noté dans ce fil.`);
  notifyEnd({
    conv: store.get(conv.id) || fresh,
    trigger,
    outcome: outcome === 'stopped' ? 'stopped' : 'error',
    error: outcome === 'done' ? decision.reason : lastErrorText(fresh) || stderr,
  });
  return decision;
}

// --- Messages planifiés ---------------------------------------------------
//
// « Envoie ça à 18 h, dans cette conversation. » Le contexte est déjà là — le ticket est lu,
// la branche identifiée — et il n'y a donc rien à réécrire, ni de risque de se tromper en le
// retapant plus tard. Enregistré côté serveur : le navigateur peut être fermé, le PC éteint.

app.get('/api/planned', (req, res) => {
  const titles = new Map(store.list().map((c) => [c.id, c.title]));
  res.json({
    planned: planned.all().map((p) => ({ ...p, convTitle: titles.get(p.convId) || null })),
    modes: planned.MODES,
  });
});

app.post('/api/conversations/:id/planned', (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

  const body = req.body || {};
  let target = conv;
  let extra = {};

  // Copie demandée : on gèle la session **tout de suite**. C'est là que le contexte est celui
  // qu'on a en tête, et la conversation enfant apparaît aussitôt dans la sidebar, en attente
  // — au lieu de naître à l'échéance avec ce que le parent est devenu entre-temps.
  if (body.mode === 'fork') {
    const frozen = sessions.freeze(conv.provider, conv.providerSessionId);
    if (frozen) {
      target = store.create({
        provider: conv.provider,
        cwd: conv.cwd,
        model: conv.model,
        effort: conv.effort,
        folder: conv.folder,
        browser: conv.browser,
        parentId: conv.id,
        title: String(body.prompt || '').trim().split('\n')[0].slice(0, 70) || 'Envoi planifié',
      });
      // `sessionStarted` avec l'identifiant de la copie : le turn de l'échéance fera donc un
      // `--resume` sur la session gelée, et non un fork de la session vivante du parent.
      store.update(target.id, { providerSessionId: frozen.sessionId, sessionStarted: true });
      extra = { mode: 'frozen', ownsConv: true, frozenSession: frozen.sessionId, fromConvId: conv.id };

      const note = store.addItem(target.id, {
        kind: 'notice',
        text:
          `Copie gelée de « ${conv.title} », prise maintenant. Le message planifié partira ` +
          "ici à l'échéance, avec le contexte tel qu'il est à cet instant — la conversation " +
          "d'origine peut continuer sans l'affecter.",
      });
      broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === target.id) });
      if (note) broadcast({ type: 'item', convId: target.id, item: note });
    }
  }

  const done = planned.add({ ...body, ...extra, convId: target.id });
  if (done.error) {
    // Le gel a eu lieu mais la planification est refusée : on ne laisse pas la copie derrière.
    if (extra.ownsConv) {
      store.remove(target.id);
      removeTraces(target.id);
      sessions.forget(conv.provider, extra.frozenSession);
      broadcast({ type: 'deleted', convId: target.id });
    }
    return res.status(400).json({ error: done.error });
  }

  broadcast({ type: 'planned', convId: conv.id });
  res.status(201).json({
    planned: done.planned,
    // La liste rendue est celle du fil d'où l'on planifie, copie comprise : c'est de là qu'on
    // regarde.
    pending: [...planned.forConversation(conv.id), ...planned.forConversation(target.id)].filter(
      (p, i, all) => all.findIndex((x) => x.id === p.id) === i
    ),
  });
});

app.delete('/api/planned/:id', (req, res) => {
  const removed = planned.cancel(req.params.id);
  if (!removed) {
    return res.status(404).json({ error: 'Message planifié introuvable ou déjà parti' });
  }
  // La copie gelée n'existait que pour ce message : l'annuler doit l'emporter, sinon une
  // conversation vide et une session copiée traîneraient indéfiniment.
  if (removed.ownsConv) {
    const target = store.get(removed.convId);
    store.remove(removed.convId);
    removeTraces(removed.convId);
    if (target) sessions.forget(target.provider, removed.frozenSession);
    broadcast({ type: 'deleted', convId: removed.convId });
  }
  broadcast({ type: 'planned' });
  res.json({ cancelled: true });
});

/**
 * Envoie un message planifié, à son échéance.
 *
 * Trois modes, et deux seulement demandent du travail ici. `frozen` n'en demande aucun : la
 * copie et la conversation enfant existent depuis la planification, il n'y a qu'à envoyer.
 * `same` pose le message dans la conversation elle-même — s'il y a un turn en cours, il rejoint
 * la file, ce qui est le comportement déjà en place et le bon. `fork` dérive une conversation
 * enfant de la session du parent, pour que le fil parent reste utilisable.
 *
 * `fork` ne subsiste que pour les fournisseurs incapables de geler leur session : la dérivation
 * a lieu maintenant, donc l'enfant hérite de ce que le parent est devenu entre-temps. Isolé,
 * mais pas figé — et l'interface le dit avant qu'on choisisse.
 *
 * Ne lance pas pour un cas prévisible — conversation disparue, fournisseur incapable de
 * forker : le message est marqué en échec avec sa raison, sinon il repartirait à chaque tick.
 */
async function sendPlanned(message) {
  const parent = store.get(message.convId);
  if (!parent) {
    planned.failed(message.id, 'La conversation a été supprimée avant l’échéance.');
    broadcast({ type: 'planned' });
    return null;
  }

  // Copie gelée : tout a été fait à la planification. La conversation visée *est* la copie,
  // avec la session figée déjà posée dessus — il n'y a plus qu'à envoyer.
  if (message.mode === 'frozen') {
    if (running.has(parent.id)) enqueue(parent, message.prompt, null);
    else await dispatch(parent, message.prompt, null);
    planned.sent(message.id, parent.id);
    broadcast({ type: 'planned' });
    return parent;
  }

  // Forker demande une session déjà ouverte et un fournisseur qui sait le faire. Sans ça on
  // retombe dans la conversation elle-même : mieux vaut un message qui part au bon endroit
  // qu'un message qui ne part pas.
  const canForkHere =
    message.mode === 'fork' && canFork(parent.provider) && parent.sessionStarted && parent.providerSessionId;

  let target = parent;
  if (canForkHere) {
    target = store.create({
      provider: parent.provider,
      cwd: parent.cwd,
      model: parent.model,
      effort: parent.effort,
      folder: parent.folder,
      browser: parent.browser,
      parentId: parent.id,
      forkFrom: parent.providerSessionId,
      title: message.prompt.split('\n')[0].slice(0, 70),
    });
    broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === target.id) });
  } else if (message.mode === 'fork') {
    const item = store.addItem(parent.id, {
      kind: 'notice',
      text:
        'Message planifié envoyé dans cette conversation plutôt que dans une copie : ' +
        (canFork(parent.provider)
          ? "la conversation n'avait pas encore de session à dériver."
          : `${parent.provider} ne sait pas dériver une session.`),
    });
    if (item) broadcast({ type: 'item', convId: parent.id, item });
  }

  // Le mode `same` et le repli d'un fork visent parfois un fil encore occupé à l'échéance.
  // Une échéance signifie « remettre le message », pas « échouer si le turn précédent dure ».
  if (running.has(target.id)) enqueue(target, message.prompt, null);
  else await dispatch(target, message.prompt, null);
  planned.sent(message.id, target.id);
  broadcast({ type: 'planned' });
  return target;
}

app.get('/api/triggers', (req, res) => {
  const perTrigger = usage.byTrigger();
  const alive = new Set(store.list().map((c) => c.id));
  res.json({
    triggers: store.triggers().map((t) => ({
      ...t,
      usage: perTrigger[t.id] || usage.NO_USAGE(),
      // `gone` marque une exécution dont la conversation a été purgée : la ligne reste
      // dans l'historique — c'est tout l'intérêt de le tenir à part — mais elle n'est
      // plus cliquable.
      runs: runs.forTrigger(t.id, RUNS_SHOWN).map((run) => ({ ...run, gone: !alive.has(run.convId) })),
    })),
    frequencies: triggers.list(),
    // L'UI ne propose l'envoi par mail que s'il peut réellement partir.
    mailReady: mail.available(),
  });
});

// Lancer maintenant, sans toucher à l'échéance : sert à vérifier une consigne avant de
// la laisser partir seule à 3 h du matin.
app.post('/api/triggers/:id/run', asyncRoute(async (req, res) => {
  const trigger = store.getTrigger(req.params.id);
  if (!trigger) return res.status(404).json({ error: 'Déclencheur introuvable' });
  const conv = await runTrigger(trigger);
  res.status(201).json({ conversation: store.get(conv.id) });
}));

/**
 * Un événement lance un agent.
 *
 * L'URL porte le jeton, et le jeton est le seul secret : quiconque l'a lance l'agent. C'est
 * le bind local par défaut réduit la surface, et le jeton protège notamment d'une URL recopiée
 * dans un service tiers qui la journalise.
 *
 * `lib/hooks.js` décide seul s'il faut lancer, et rend un motif en clair : un service dont le
 * webhook est refusé doit pouvoir lire pourquoi dans sa propre journalisation, sinon le
 * silence passe pour une panne.
 */
app.post('/api/hooks/:token', asyncRoute(async (req, res) => {
  const token = String(req.params.token || '');
  // Le jeton est comparé en entier, jamais préfixé : `find` sur l'égalité stricte, et un
  // déclencheur sans jeton n'est jamais atteignable même si le jeton reçu est vide.
  const trigger = token ? store.triggers().find((t) => t.hookToken === token) || null : null;

  const verdict = hooks.admit(trigger, {
    // La conversation de la dernière exécution travaille-t-elle encore ? Refuser vaut mieux
    // que mettre en file : une file de webhooks se vide en agents simultanés.
    running: Boolean(trigger && trigger.lastConvId && running.has(trigger.lastConvId)),
  });
  if (!verdict.ok) return res.status(verdict.status).json({ error: verdict.reason });

  const conv = await runTrigger(trigger, {
    prompt: hooks.prompt(trigger, req.body, { source: req.get('user-agent') }),
  });
  res.status(201).json({ convId: conv.id });
}));

app.post('/api/triggers', (req, res) => {
  const checked = triggers.validate(req.body, PROVIDERS);
  if (checked.error) return res.status(400).json({ error: checked.error });

  const cwdError = checkTriggerCwd(checked.trigger.cwd);
  if (cwdError) return res.status(400).json({ error: cwdError });

  // `null` est une réponse valide : un déclencheur sur événement n'a pas d'échéance, et une
  // exécution unique n'en a plus après la sienne.
  const next = triggers.nextRun(checked.trigger, new Date(), { first: true });
  const trigger = store.createTrigger({
    ...checked.trigger,
    nextRunAt: next ? next.toISOString() : null,
    // Le jeton naît avec le déclencheur, et vit aussi longtemps que lui : le régénérer à
    // chaque modification casserait en silence l'URL déjà recopiée dans le service tiers.
    hookToken: triggers.isHook(checked.trigger.frequency) ? hooks.newToken() : null,
  });

  broadcast({ type: 'triggers', triggers: store.triggers() });
  broadcast({ type: 'folders', folders: store.folders() });
  res.status(201).json({ trigger });
});

app.patch('/api/triggers/:id', (req, res) => {
  const current = store.getTrigger(req.params.id);
  if (!current) return res.status(404).json({ error: 'Déclencheur introuvable' });

  // Validation sur la fusion et non sur le corps seul : modifier la seule fréquence ne
  // doit pas faire échouer la validation du reste, et une heure devenue interdite doit
  // être vue comme telle.
  const merged = { ...current, ...req.body };
  // Une heure héritée d'une cadence précédente ne doit pas bloquer un changement de
  // fréquence : on l'abandonne. Seule une heure explicitement envoyée avec une fréquence
  // qui n'en accepte pas est refusée.
  const hourSent = Object.prototype.hasOwnProperty.call(req.body || {}, 'hour');
  if (!hourSent && !triggers.acceptsHour(merged.frequency)) merged.hour = null;

  const checked = triggers.validate(merged, PROVIDERS);
  if (checked.error) return res.status(400).json({ error: checked.error });

  const cwdError = checkTriggerCwd(checked.trigger.cwd);
  if (cwdError) return res.status(400).json({ error: cwdError });

  const patch = { ...checked.trigger };
  // La cadence a changé : l'échéance en cours n'a plus de sens, on la recalcule. Pour une
  // exécution unique, c'est l'instant choisi qui joue ce rôle — le modifier réarme le
  // déclencheur, ce qui est précisément comment on relance un one-shot déjà passé.
  const rescheduled =
    checked.trigger.frequency !== current.frequency ||
    checked.trigger.hour !== current.hour ||
    JSON.stringify(checked.trigger.weekdays) !== JSON.stringify(current.weekdays || null) ||
    checked.trigger.runAt !== current.runAt;
  if (rescheduled || !current.nextRunAt) {
    const next = triggers.nextRun(checked.trigger, new Date(), { first: true });
    patch.nextRunAt = next ? next.toISOString() : null;
  }

  // Un déclencheur qui devient « sur événement » reçoit son jeton, et celui qui en avait un
  // le garde : `validate` recopie ce qu'on lui donne, jamais plus.
  if (triggers.isHook(checked.trigger.frequency)) {
    patch.hookToken = current.hookToken || hooks.newToken();
  }

  // Échéance forcée. Sert à réarmer un déclencheur à la main, et à vérifier le
  // planificateur sans attendre une heure réelle. Appliquée en dernier pour primer sur le
  // recalcul ci-dessus.
  if (typeof req.body.nextRunAt === 'string') {
    const at = new Date(req.body.nextRunAt);
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Échéance invalide' });
    patch.nextRunAt = at.toISOString();
  }

  const trigger = store.updateTrigger(req.params.id, patch);
  broadcast({ type: 'triggers', triggers: store.triggers() });
  broadcast({ type: 'folders', folders: store.folders() });
  res.json({ trigger });
});

app.delete('/api/triggers/:id', (req, res) => {
  if (!store.removeTrigger(req.params.id)) {
    return res.status(404).json({ error: 'Déclencheur introuvable' });
  }
  // Les conversations produites survivent au déclencheur, mais son historique n'a plus
  // personne à qui se rattacher : sans cet oubli, le journal ne décroîtrait jamais.
  runs.forget(req.params.id);
  broadcast({ type: 'triggers', triggers: store.triggers() });
  res.json({ deleted: true });
});

app.get('/api/conversations/:id', asyncRoute(async (req, res) => {
  const paginated = Object.prototype.hasOwnProperty.call(req.query, 'limit');
  const conv = paginated ? store.getMeta(req.params.id) : store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  // Ouvrir une conversation terminée l'acquitte.
  if (conv.status === 'done') {
    const acknowledged = store.updateMeta(conv.id, { status: 'idle' });
    Object.assign(conv, { status: 'idle', updatedAt: acknowledged.updatedAt });
    broadcast({
      type: 'status',
      convId: conv.id,
      status: 'idle',
      updatedAt: conv.updatedAt,
      modelSelection: selectionState(conv),
    });
  }
  // La file est renvoyée sans les chemins disque des images. `lastModels` reste compatible
  // avec les anciens clients, mais ne reçoit plus le défaut de la table de tarifs.
  const selected = selectionState(conv);
  const lastModels = (selected.last && selected.last.models) || [];
  // Sans `limit`, l'ancienne réponse reste disponible le temps que tous les clients passent
  // à la pagination. Avec `limit`, seuls les derniers échanges (ou la fenêtre demandée) et
  // des aperçus de sorties d'outils traversent le réseau.
  const window = paginated ? await searchService.page(conv.id, req.query) : null;
  res.json({
    conversation: {
      ...conv,
      items: window ? window.items : conv.items,
      lastModels,
      modelSelection: selected,
      queue: publicQueue(conv),
    },
    running: running.has(conv.id),
    // La question en attente vit côté serveur : elle doit réapparaître après un
    // rechargement, et se voir depuis un second appareil.
    ask: asks.pendingFor(conv.id),
    ...(window ? { page: window.page } : {}),
  });
}));

/** Sortie complète d'un outil, chargée seulement sur une action explicite de l'utilisateur. */
app.get('/api/conversations/:id/items/:itemId/result', asyncRoute(async (req, res) => {
  const conv = store.getMeta(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const found = await searchService.result(conv.id, req.params.itemId);
  if (!found.found) return res.status(404).json({ error: 'Élément introuvable' });
  res.json({ result: found.result });
}));

app.get('/api/conversations/:id/landmarks', asyncRoute(async (req, res) => {
  if (!store.getMeta(req.params.id)) return res.status(404).json({ error: 'Conversation introuvable' });
  res.json(await searchService.landmarks(req.params.id));
}));

/** Où en est la branche isolée : ce qui reste à commiter, et ce qu'une fusion apporterait. */
app.get('/api/conversations/:id/worktree', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  if (!conv.worktree) return res.json({ worktree: null });
  try {
    res.json({ worktree: conv.worktree, state: await worktrees.state(conv.worktree) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

/**
 * Rapporte la branche isolée dans le dépôt principal.
 *
 * Refusé pendant qu'un agent travaille : il écrit dans le worktree au moment même où la
 * fusion lit son état, et ce qu'on fusionnerait ne serait ni ce qu'il a fini ni ce qu'il a
 * commencé. Les autres refus — travail non commité, dépôt principal sale, conflit — sont
 * dans `lib/worktrees.js`, avec la raison de chacun.
 */
app.post('/api/conversations/:id/worktree/merge', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  if (!conv.worktree) return res.status(400).json({ error: "Cette conversation n'est pas isolée" });
  if (running.has(conv.id)) {
    return res.status(409).json({ error: "L'agent travaille : attends la fin du turn." });
  }
  try {
    const done = await worktrees.merge(conv.worktree);
    const item = store.addItem(conv.id, {
      kind: 'notice',
      text: `${done.commits} commit(s) de ${done.merged} fusionné(s) dans ${done.into}.`,
    });
    if (item) broadcast({ type: 'item', convId: conv.id, item });
    res.json({ merged: done, state: await worktrees.state(conv.worktree) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}));

app.post('/api/conversations', asyncRoute(async (req, res) => {
  const {
    provider,
    cwd,
    model,
    prompt,
    effort,
    parentId,
    folder: wantedFolder,
    browser: wantsBrowser,
    goal: wantsGoal,
    rounds,
    worktree: wantsWorktree,
  } = req.body || {};
  if (!PROVIDERS.has(provider)) {
    return res.status(400).json({ error: 'Provider inconnu' });
  }
  const checkedSelection = modelSelection.patch(
    { provider, model: null, effort: null },
    {
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
    }
  );
  if (checkedSelection.error) return res.status(400).json({ error: checkedSelection.error });
  if (parentId && !store.get(parentId)) {
    return res.status(400).json({ error: 'Conversation parente introuvable' });
  }
  // Un dossier vide veut dire « sans projet » : la conversation reçoit un dossier de
  // travail à elle, sous `data/scratch/`. L'agent a besoin d'un cwd de toute façon, et le
  // lâcher dans un dossier qui contient autre chose serait une surprise désagréable.
  const noProject = !cwd;
  if (!noProject && (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
    return res.status(400).json({ error: `Dossier introuvable : ${cwd}` });
  }

  // Rangement par défaut : le dossier du projet. Une conversation dérivée suit son parent
  // — un relais appartient à la même affaire que ce dont il est issu, même si le parent a
  // été déplacé à la main depuis. Sans projet, pas de dossier : elle vit dans « Récents ».
  //
  // Un dossier explicite l'emporte sur les deux, et c'est ce qui rend possible « nouvelle
  // conversation dans ce dossier » depuis la sidebar : un dossier créé à la main n'a pas de
  // `cwd`, donc `folderForCwd` ne le retrouverait jamais et la conversation atterrirait dans
  // « Récents » — soit à côté du dossier sur lequel on vient de cliquer. Un identifiant
  // inconnu est ignoré plutôt que refusé : le rangement n'est pas ce qui justifie de perdre
  // la conversation qu'on demande.
  const from = parentId ? store.get(parentId) : null;
  const named = wantedFolder && store.folders().some((f) => f.id === wantedFolder);
  const folder = named
    ? wantedFolder
    : from
      ? from.folder
      : noProject
        ? null
        : (store.folderForCwd(cwd) || {}).id || null;

  const first = prompt && prompt.trim();
  const conv = store.create({
    provider,
    // Provisoire quand il n'y a pas de projet : le vrai chemin dépend de l'identifiant,
    // qui n'existe qu'une fois la conversation créée.
    cwd: cwd || '',
    model: checkedSelection.patch.model || null,
    effort: checkedSelection.patch.effort || null,
    folder,
    parentId: parentId || null,
    // Refusé pour un fournisseur qui ne sait pas recevoir de config MCP à l'appel : mieux
    // vaut une case sans effet visible qu'une conversation qui se croit outillée.
    browser: Boolean(wantsBrowser) && browserMcp.supports(provider),
    // Titre d'attente : la première ligne du message, le temps que le modèle en écrive un
    // vrai — quelques secondes plus tard, depuis `dispatch`. Sans consigne, il n'y a encore
    // rien à nommer et le titre viendra du premier message envoyé du composeur.
    title: titles.fromText(first),
    titleAuto: true,
  });

  if (noProject) {
    const dir = scratchDir(conv.id);
    fs.mkdirSync(dir, { recursive: true });
    store.update(conv.id, { cwd: dir });
    conv.cwd = dir;
  } else if (wantsWorktree) {
    // Comme le dossier bac à sable ci-dessus, le worktree se crée *après* la conversation :
    // son chemin et son nom de branche dérivent de l'identifiant.
    try {
      const wt = await worktrees.create({ convId: conv.id, cwd });
      store.update(conv.id, { cwd: wt.path, worktree: wt });
      conv.cwd = wt.path;
      conv.worktree = wt;
    } catch (err) {
      // La conversation isolée demandée n'existe pas : la rendre non isolée sans le dire
      // ferait écrire l'agent dans le dossier du projet, exactement ce qu'on voulait éviter.
      store.remove(conv.id);
      return res.status(400).json({ error: err.message });
    }
  }

  let saved;
  try {
    saved = uploads.save(conv.id, req.body.images);
  } catch (err) {
    store.remove(conv.id);
    return res.status(400).json({ error: err.message });
  }

  // Le dossier du projet peut venir d'être créé : la sidebar doit l'apprendre, sinon la
  // conversation se range dans un dossier que le navigateur ne connaît pas encore.
  broadcast({ type: 'folders', folders: store.folders() });
  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === conv.id) });
  // Sans consigne, la conversation s'ouvre et n'envoie rien : le premier message partira
  // du composeur. Des images envoyées sans consigne ne sont rattachées à aucun message —
  // elles restent dans le dossier de la conversation et partent avec elle.
  //
  // Avec le mode objectif, la consigne *est* l'objectif : elle ouvre la boucle au lieu de
  // partir telle quelle.
  if (first && wantsGoal) {
    const goal = goals.start(first, rounds);
    setGoal(conv.id, goal);
    await dispatch(store.get(conv.id), goals.buildFirstPrompt(goal.text), saved, {
      goal: 'start',
      goalText: goal.text,
    });
  } else if (first) {
    await dispatch(conv, first, saved);
  }
  res.status(201).json({ conversation: store.get(conv.id) });
}));

/**
 * Ouvre un objectif : la conversation ne s'arrêtera plus au premier turn qui finit.
 *
 * Refusé pendant qu'un turn tourne : le premier tour part tout de suite, et le mettre en file
 * ferait démarrer la boucle sur un contexte qu'on ne connaît pas encore.
 */
app.post('/api/conversations/:id/goal', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const objective = ((req.body && req.body.objective) || '').trim();
  if (!objective) return res.status(400).json({ error: 'Objectif vide' });
  if (conv.goal) return res.status(409).json({ error: 'Un objectif est déjà en cours ici.' });
  if (running.has(conv.id)) {
    return res.status(409).json({ error: "L'agent travaille : attends la fin du turn, ou interromps-le." });
  }

  let saved;
  try {
    saved = uploads.save(conv.id, req.body.images);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const goal = goals.start(objective, req.body && req.body.rounds);
  setGoal(conv.id, goal);
  await dispatch(store.get(conv.id), goals.buildFirstPrompt(goal.text), saved, {
    goal: 'start',
    goalText: goal.text,
  });
  res.status(201).json({ goal });
}));

/** Abandonne l'objectif. Le turn en cours, lui, continue : c'est la boucle qu'on arrête. */
app.delete('/api/conversations/:id/goal', (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  if (!conv.goal) return res.status(409).json({ error: 'Aucun objectif en cours' });
  setGoal(conv.id, null);
  const item = store.addItem(conv.id, {
    kind: 'notice',
    text: 'Mode objectif abandonné. Le turn en cours, lui, va jusqu’au bout.',
  });
  if (item) broadcast({ type: 'item', convId: conv.id, item });
  res.json({ abandoned: true });
});

app.post('/api/conversations/:id/messages', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const prompt = (req.body && req.body.prompt) || '';
  if (!prompt.trim()) return res.status(400).json({ error: 'Message vide' });

  let saved;
  try {
    saved = uploads.save(conv.id, req.body.images);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  if (running.has(conv.id)) {
    // L'agent travaille : le message attend dans la file, hors du fil.
    const entry = enqueue(conv, prompt, saved);
    return res.json({ queued: true, id: entry.id, size: (conv.queue || []).length });
  }

  await dispatch(conv, prompt, saved);
  res.json({ queued: false });
}));

// --- Gestion de la file ---------------------------------------------------

function withQueued(req, res, handler) {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const entry = (conv.queue || []).find((q) => q.id === req.params.qid);
  if (!entry) return res.status(404).json({ error: 'Message en attente introuvable' });
  return handler(conv, entry);
}

app.patch('/api/conversations/:id/queue/:qid', (req, res) =>
  withQueued(req, res, (conv, entry) => {
    const { text, removeImageUrls, addImages } = req.body || {};

    if (typeof text === 'string') {
      if (!text.trim()) return res.status(400).json({ error: 'Message vide' });
      entry.text = text;
    }

    if (Array.isArray(removeImageUrls) && removeImageUrls.length) {
      const drop = entry.images.filter((img) => removeImageUrls.includes(img.url));
      entry.images = entry.images.filter((img) => !removeImageUrls.includes(img.url));
      uploads.removeFiles(drop.map((img) => img.path));
    }

    if (Array.isArray(addImages) && addImages.length) {
      try {
        const room = uploads.MAX_PER_TURN - entry.images.length;
        if (addImages.length > room) {
          return res.status(400).json({ error: `${uploads.MAX_PER_TURN} pièces jointes maximum par message` });
        }
        entry.images.push(...uploads.save(conv.id, addImages));
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    store.update(conv.id, { queue: conv.queue });
    broadcastQueue(conv);
    return res.json({ queued: publicQueue(conv) });
  })
);

app.delete('/api/conversations/:id/queue/:qid', (req, res) =>
  withQueued(req, res, (conv, entry) => {
    uploads.removeFiles((entry.images || []).map((img) => img.path));
    dequeue(conv, entry.id);
    return res.json({ queued: publicQueue(conv) });
  })
);

// « Envoyer comme instruction » : part tout de suite si l'agent est libre, sinon
// remonte en tête de file.
app.post('/api/conversations/:id/queue/:qid/promote', asyncRoute(async (req, res) =>
  withQueued(req, res, async (conv, entry) => {
    if (running.has(conv.id)) {
      const queue = [entry, ...(conv.queue || []).filter((q) => q.id !== entry.id)];
      store.update(conv.id, { queue });
      conv.queue = queue;
      broadcastQueue(conv);
      return res.json({ promoted: true, sent: false });
    }
    const started = await dispatchQueued(conv, entry);
    if (!started) {
      return res.status(409).json({
        error: 'Envoi interrompu avant le lancement ; le message reste en file.',
      });
    }
    return res.json({ promoted: true, sent: true });
  })
));

app.post('/api/conversations/:id/queue/order', (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const ids = (req.body && req.body.ids) || [];
  const current = conv.queue || [];
  const ordered = orderQueue(current, ids);
  store.update(conv.id, { queue: ordered });
  conv.queue = ordered;
  broadcastQueue(conv);
  res.json({ queued: publicQueue(conv) });
});

// Images produites par un agent, référencées en markdown dans ses réponses.
//
// Les agents écrivent `![alt](chemin)` avec un chemin relatif à quelque chose que
// l'UI ignore : Grok le fait relativement à son dossier de session, Claude et Codex
// plutôt au dossier de travail. On essaie donc plusieurs racines, et on refuse tout
// ce qui sort des racines autorisées.
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

function imageRoots(conv) {
  const roots = [conv.cwd];
  if (conv.providerSessionId) {
    // Convention de Grok : ~/.grok/sessions/<cwd encodé>/<session>/
    roots.push(
      path.join(
        os.homedir(),
        '.grok',
        'sessions',
        encodeURIComponent(conv.cwd),
        conv.providerSessionId
      )
    );
  }
  return roots.map((r) => path.resolve(r));
}

/** @returns {string|null} chemin absolu sûr, ou null */
function resolveImage(conv, wanted) {
  if (!wanted || !IMAGE_EXT.has(path.extname(wanted).toLowerCase())) return null;
  const roots = imageRoots(conv);

  const candidates = path.isAbsolute(wanted)
    ? [path.resolve(wanted)]
    : roots.map((root) => path.resolve(root, wanted));

  for (const candidate of candidates) {
    // Le chemin résolu doit rester sous une racine autorisée : c'est ce qui bloque
    // les remontées en `../`.
    const allowed = roots.some(
      (root) => candidate === root || candidate.startsWith(`${root}${path.sep}`)
    );
    if (!allowed) continue;
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* candidat suivant */
    }
  }
  return null;
}

app.get('/api/conversations/:id/image', (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

  const file = resolveImage(conv, req.query.path);
  if (!file) return res.status(404).json({ error: 'Image introuvable ou chemin refusé' });

  res.sendFile(file, { maxAge: '1h' }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Fichiers modifiés depuis un instantané, pour montrer l'impact avant de restaurer.
app.get('/api/conversations/:id/checkpoints/:sha/diff', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  try {
    res.json({ files: await checkpoints.diff(conv, req.params.sha) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post('/api/conversations/:id/checkpoints/:sha/restore', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  if (running.has(conv.id)) {
    return res.status(409).json({ error: "L'agent travaille : interromps-le avant de restaurer." });
  }
  try {
    const result = await checkpoints.restore(conv, req.params.sha);
    // Trace dans le fil : une restauration change le disque, ça doit être visible.
    // On y accroche l'instantané de sécurité pour que l'annulation soit à un clic.
    const item = store.addItem(conv.id, {
      kind: 'notice',
      text: `Fichiers restaurés à l'état d'avant ce point (${result.files.length} fichier(s) touché(s)).`,
      checkpoint: result.safety && result.safety.sha ? result.safety : null,
      checkpointLabel: "Annuler cette restauration",
    });
    broadcast({ type: 'item', convId: conv.id, item });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- Dépôt du dossier de travail ------------------------------------------

/**
 * Graphe du dépôt réel de la conversation, pour le panneau de l'en-tête.
 *
 * `?probe=1` ne remonte que l'existence du dépôt. C'est ce qui décide si le bouton du
 * panneau s'affiche, et ça évite de lire un `log` complet à chaque ouverture de
 * conversation. « Pas un dépôt » n'est pas une erreur : on répond 200 avec
 * `repo: false`, le front n'a alors qu'à cacher le bouton.
 */
app.get('/api/conversations/:id/git', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });

  try {
    if (req.query.probe) {
      const top = await gitRepo.root(conv.cwd);
      return res.json({ repo: Boolean(top), root: top });
    }
    res.json(
      await gitRepo.graph(conv.cwd, {
        limit: req.query.limit,
        // `fetch=1` force la mise à jour des références distantes sans attendre le délai de
        // grâce : c'est le bouton de rafraîchissement du panneau.
        fetch: req.query.fetch === '1',
      })
    );
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- Relais ---------------------------------------------------------------
//
// Dériver une conversation vers un autre agent ou un autre modèle, dans une
// conversation enfant, sans rien consommer du parent. Deux points de départ : un
// fichier que le parent a écrit, ou son contexte de conversation — ce second cas
// n'étant possible que vers le même fournisseur, et seulement s'il sait forker.

/** @returns {string|null} chemin absolu du fichier de départ, ou null s'il est refusé. */
function resolveRelayFile(conv, wanted) {
  if (!wanted || !String(wanted).trim()) return null;
  const root = path.resolve(conv.cwd);
  const candidate = path.isAbsolute(wanted)
    ? path.resolve(wanted)
    : path.resolve(root, String(wanted).trim());
  // Comme pour les images : le chemin résolu doit rester sous le dossier de travail,
  // ce qui bloque les remontées en `../`.
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

/**
 * Demande à l'agent du parent d'écrire sa note de passation, et l'enregistre.
 *
 * Le turn est visible dans le fil du parent. L'alternative — forker sa session pour lui
 * demander la note sans polluer son fil — est plus propre mais asymétrique : Codex ne
 * sait pas forker, le cas se dégraderait donc chez lui seul. Le turn visible traite les
 * trois fournisseurs identiquement, et la note dans le fil est une trace utile de ce qui
 * a été transmis. Prix payé : un turn de plus dans la conversation parente.
 *
 * @returns {Promise<string>} chemin absolu du fichier de note
 */
async function writeHandoffNote(parent) {
  const before = (store.get(parent.id).items || []).length;
  const prepared = await prepareTurn({
    id: parent.id,
    running,
    exists: () => Boolean(store.get(parent.id)),
    prepare: async () => {
      setStatus(parent.id, 'working');
      return checkpoints.snapshot(parent, 'avant note de passation');
    },
    onCancel: () => setStatus(parent.id, 'stopped'),
    onError: () => setStatus(parent.id, 'error'),
    start: (checkpoint, reservation) => {
      const request = store.addItem(parent.id, {
        kind: 'user', text: handoff.REQUEST, handoff: 'request', checkpoint,
      });
      broadcast({ type: 'item', convId: parent.id, item: request });
      return {
        done: startTurn(parent, handoff.REQUEST, [], { isHandoff: true }, reservation),
      };
    },
  });
  if (!prepared) throw new Error('La note de passation a été interrompue avant son lancement.');
  const outcome = await prepared.done;
  if (outcome.stopped) throw new Error('La note de passation a été interrompue.');
  if (outcome.failed) {
    throw new Error("L'agent n'a pas pu écrire sa note de passation ; l'erreur est dans son fil.");
  }

  // Bornée aux items produits par ce turn : sans ça, un turn muet ferait passer une
  // vieille réponse pour la note.
  const produced = (store.get(parent.id).items || []).slice(before + 1);
  const note = [...produced].reverse().find((i) => i.kind === 'text' && i.text && i.text.trim());
  if (!note) throw new Error("L'agent n'a produit aucun texte : pas de note de passation.");

  const file = handoff.write(parent.id, note.text);
  note.handoff = 'note';
  note.handoffFile = path.basename(file);
  store.touchItem(parent.id, note);
  broadcast({ type: 'itemUpdate', convId: parent.id, item: note });
  return file;
}

// Fichiers markdown que la conversation a créés ou modifiés, candidats au relais.
app.get('/api/conversations/:id/relay/files', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  try {
    const sha = await checkpoints.firstSha(conv);
    if (!sha) return res.json({ files: [], warning: 'Aucun instantané pour cette conversation.' });
    const changed = await checkpoints.diff(conv, sha);
    const files = changed
      .filter((f) => f.status !== 'D')
      // Un renommage est rendu « ancien → nouveau » : seul le nouveau chemin existe.
      .map((f) => (f.status === 'R' || f.status === 'C' ? f.path.split(' → ').pop() : f.path))
      .filter((p) => /\.(md|markdown)$/i.test(p));
    res.json({ files: [...new Set(files)].sort() });
  } catch (err) {
    // Une liste indisponible ne doit pas bloquer un relais : la saisie libre reste là.
    res.json({ files: [], warning: err.message });
  }
}));

app.post('/api/conversations/:id/relay', asyncRoute(async (req, res) => {
  const parent = store.get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Conversation introuvable' });

  const { from, file, provider, model, effort } = req.body || {};
  const prompt = ((req.body && req.body.prompt) || '').trim();

  if (!PROVIDERS.has(provider)) return res.status(400).json({ error: 'Provider inconnu' });
  if (!prompt) return res.status(400).json({ error: 'Consigne vide' });
  if (from !== 'file' && from !== 'conversation') {
    return res.status(400).json({ error: 'Point de départ inconnu' });
  }
  const checkedSelection = modelSelection.patch(
    { provider, model: null, effort: null },
    {
      ...(typeof model === 'string' ? { model } : {}),
      ...(typeof effort === 'string' ? { effort } : {}),
    }
  );
  if (checkedSelection.error) return res.status(400).json({ error: checkedSelection.error });

  let text = prompt;
  let forkFrom = null;
  let noteFile = null;

  if (from === 'file') {
    const resolved = resolveRelayFile(parent, file);
    if (!resolved) {
      return res.status(400).json({ error: 'Fichier introuvable ou hors du dossier de travail' });
    }
    text = `${prompt}\n\nPoint de départ : ${resolved}\nCommence par lire ce fichier : il porte le travail à reprendre.`;
  } else if (!parent.sessionStarted || !parent.providerSessionId) {
    return res
      .status(409)
      .json({ error: "La conversation parente n'a encore rien produit à transmettre." });
  } else if (provider === parent.provider && canFork(provider)) {
    // Même fournisseur et il sait forker : l'enfant démarre sur le contexte complet, et
    // rien n'est à produire.
    forkFrom = parent.providerSessionId;
  } else {
    // Relais croisé. Le fil ne peut pas voyager — fournisseurs incompatibles, ou fenêtres
    // de contexte inégales — donc l'agent du parent écrit ce qu'il transmet.
    if (running.has(parent.id)) {
      return res.status(409).json({
        error:
          "L'agent du parent travaille, et la note de passation lui demande un turn. " +
          "Attends qu'il ait fini, ou interromps-le.",
      });
    }
    try {
      noteFile = await writeHandoffNote(parent);
    } catch (err) {
      // Pas de note, pas d'enfant : lancer un agent sans contexte ne rendrait service
      // à personne.
      return res.status(502).json({ error: err.message });
    }
    text = handoff.childPrompt(prompt, noteFile);
  }

  const child = store.create({
    provider,
    cwd: parent.cwd,
    model: checkedSelection.patch.model || null,
    effort: checkedSelection.patch.effort || null,
    parentId: parent.id,
    forkFrom,
    title: titles.fromText(prompt),
    titleAuto: true,
  });

  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === child.id) });
  await dispatch(child, text, null);
  res.status(201).json({
    conversation: store.get(child.id),
    handoff: noteFile ? path.basename(noteFile) : null,
    forked: Boolean(forkFrom),
  });
}));

/**
 * Force un `/compact` dans la session CLI courante.
 *
 * Ce n'est pas une réécriture du journal UI : le contexte utile vit chez le provider.
 * Claude et Grok comprennent la slash ; Codex n'a pas d'équivalent — on refuse plutôt
 * que d'envoyer un prompt qui serait lu comme du texte.
 */
app.post('/api/conversations/:id/compact', asyncRoute(async (req, res) => {
  const conv = store.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  if (!contextActions.supportsCompact(conv.provider)) {
    return res.status(400).json({
      error: `${conv.provider} ne gère pas /compact. Utilise « Reprendre léger » pour une session neuve.`,
    });
  }
  if (!conv.sessionStarted) {
    return res.status(409).json({ error: "Rien à compacter : la session n'a pas encore démarré." });
  }

  const keep =
    typeof (req.body && req.body.keep) === 'string' ? req.body.keep : contextActions.DEFAULT_KEEP;
  const prompt = contextActions.compactPrompt({ keep });

  if (running.has(conv.id)) {
    const entry = enqueue(conv, prompt, null);
    return res.json({ queued: true, id: entry.id, size: (conv.queue || []).length });
  }

  await dispatch(conv, prompt, null, { contextAction: 'compact' });
  res.json({ queued: false });
}));

/**
 * Nouvelle conversation « légère » : note de passation, jamais de fork de session.
 *
 * Même quand le provider sait forker, on refuse le fork ici — c'est précisément le
 * contexte saturé qu'on veut laisser derrière. Si le parent est en erreur ou occupe,
 * on écrit une note synthétique à partir du fil pour que ça marche aussi sur une
 * session morte (cas typique après un « Échec du turn »).
 */
app.post('/api/conversations/:id/resume-light', asyncRoute(async (req, res) => {
  const parent = store.get(req.params.id);
  if (!parent) return res.status(404).json({ error: 'Conversation introuvable' });
  if (!(parent.items || []).some((it) => it.kind === 'user')) {
    return res
      .status(409)
      .json({ error: "La conversation n'a encore rien produit à transmettre." });
  }

  const instruction =
    ((req.body && req.body.prompt) || '').trim() || contextActions.DEFAULT_RESUME_PROMPT;
  const forceSynthetic = Boolean(req.body && req.body.synthetic);
  const parentBusy = running.has(parent.id);
  let noteFile = null;
  let synthetic = false;

  const useSynthetic = contextActions.preferSynthetic({
    status: parent.status,
    running: parentBusy,
    forceSynthetic,
  });

  if (!useSynthetic) {
    try {
      noteFile = await writeHandoffNote(parent);
    } catch (err) {
      // Session qui refuse encore un turn : on bascule sur la note synthétique plutôt
      // que d'abandonner l'utilisateur avec le même « Échec du turn ».
      synthetic = true;
      noteFile = handoff.write(
        parent.id,
        contextActions.syntheticNote({
          ...parent,
          items: store.get(parent.id).items || [],
        })
      );
      console.warn(`resume-light : note agent impossible (${err.message}), note synthétique écrite`);
    }
  } else {
    synthetic = true;
    noteFile = handoff.write(
      parent.id,
      contextActions.syntheticNote({
        ...parent,
        items: parent.items || [],
      })
    );
  }

  const text = contextActions.lightResumePrompt(instruction, noteFile);
  const child = store.create({
    provider: parent.provider,
    cwd: parent.cwd,
    model: parent.model || null,
    effort: parent.effort || null,
    browser: parent.browser || false,
    folder: parent.folder || null,
    parentId: parent.id,
    forkFrom: null,
    title: titles.fromText(`Reprise · ${parent.title || instruction}`),
    titleAuto: true,
  });

  broadcast({ type: 'conversation', conversation: store.list().find((c) => c.id === child.id) });
  await dispatch(child, text, null, {
    contextAction: 'resume-light',
    handoff: 'request',
  });
  res.status(201).json({
    conversation: store.get(child.id),
    handoff: path.basename(noteFile),
    synthetic,
    forked: false,
  });
}));

app.post('/api/conversations/:id/stop', (req, res) => {
  // La file n'est pas vidée : interrompre l'agent ne doit pas jeter les messages que tu
  // avais préparés. Ils restent en attente, à toi de les relancer.
  if (!stopConversation(req.params.id)) {
    return res.status(409).json({ error: 'Aucun turn en cours' });
  }
  res.json({ stopped: true });
});

app.patch('/api/conversations/:id', (req, res) => {
  const conv = store.getMeta(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation introuvable' });
  const patch = {};
  if (typeof req.body.archived === 'boolean') {
    if (req.body.archived && running.has(conv.id)) {
      return res.status(409).json({ error: 'Attends la fin du travail avant d’archiver ce fil.' });
    }
    patch.archived = req.body.archived;
  }
  if (typeof req.body.title === 'string' && req.body.title.trim()) {
    patch.title = req.body.title.trim().slice(0, 120);
    // Un titre écrit à la main est définitif : le modèle ne le reprendra pas.
    patch.titleAuto = false;
  }
  const checkedSelection = modelSelection.patch(conv, req.body || {});
  if (checkedSelection.error) return res.status(400).json({ error: checkedSelection.error });
  Object.assign(patch, checkedSelection.patch);
  if (typeof req.body.pinned === 'boolean') patch.pinned = req.body.pinned;
  // Le navigateur se branche au turn suivant, comme l'effort : rien à reconstruire.
  if (typeof req.body.browser === 'boolean') patch.browser = req.body.browser;
  if ('folder' in req.body) {
    const target = req.body.folder || null;
    if (target && !store.folders().some((f) => f.id === target)) {
      return res.status(400).json({ error: 'Dossier inconnu' });
    }
    patch.folder = target;
  }
  const updated = store.updateMeta(conv.id, patch);
  const selected = selectionState(updated);
  const listed = store.list().find((c) => c.id === conv.id);
  broadcast({
    type: 'conversation',
    conversation: {
      ...listed,
      model: updated.model,
      effort: updated.effort,
      modelSelection: selected,
    },
  });
  // Une modification de titre/modèle/rangement n'a pas besoin de retransmettre les dizaines
  // de Mo du fil complet. L'interface recharge ses métadonnées via la sidebar.
  const { items, ...metadata } = updated;
  res.json({
    conversation: {
      ...metadata,
      modelSelection: selected,
      applies:
        running.has(conv.id) &&
        (typeof req.body.model === 'string' || typeof req.body.effort === 'string')
          ? 'next-turn'
          : 'now',
      queue: publicQueue(updated),
    },
  });
});

/** Efface les traces disque d'une conversation : images, instantanés, notes. */
function removeTraces(id) {
  uploads.removeConversation(id);
  checkpoints.removeConversation(id);
  handoff.removeConversation(id);
  // Dossier de travail d'une conversation sans projet : il n'appartient qu'à elle, il
  // disparaît avec elle. Sans ça `data/scratch/` grossirait d'un dossier par discussion.
  fs.rmSync(scratchDir(id), { recursive: true, force: true });
}

/** Dossier de travail d'une conversation sans projet. */
function scratchDir(convId) {
  return path.join(store.DATA_DIR, 'scratch', convId);
}

/**
 * Retire un worktree propre, en conservant les dossiers sales, partagés ou dont l'état
 * est inconnu. La suppression attend ce relevé et indique au navigateur ce qui a été gardé.
 */
async function dropWorktree(conv) {
  if (!conv || !conv.worktree) return null;
  const wt = conv.worktree;
  const root = path.resolve(wt.path);
  const shared = store.list().some((entry) => {
    if (entry.id === conv.id || !entry.cwd) return false;
    const cwd = path.resolve(entry.cwd);
    return cwd === root || cwd.startsWith(`${root}${path.sep}`);
  });
  let done;
  if (shared) {
    done = { removed: false, branchKept: true, branch: wt.branch, path: wt.path, reason: 'shared' };
  } else {
    try {
      done = await worktrees.remove(wt);
    } catch (err) {
      console.error(`worktree non retiré (${conv.id}) : ${err.message}`);
      done = { removed: false, branchKept: true, branch: wt.branch, path: wt.path, reason: 'unknown-state' };
    }
  }
  if (!done.removed) console.log(`worktree conservé : ${wt.path} (${done.reason})`);
  else if (done.branchKept) console.log(`worktree retiré, branche ${done.branch} conservée`);
  return done;
}

/**
 * Suppression automatique d'une exécution. Contrairement à la suppression manuelle, elle
 * épargne toute conversation ayant des enfants : un relais encore vivant ne doit pas
 * perdre le contexte dont il est issu.
 * @returns {boolean} true si la suppression a eu lieu
 */
async function purgeRun(id) {
  if (running.has(id)) return false; // une exécution en cours ne se purge pas
  const conv = store.get(id); // relu avant la purge : après, son worktree est introuvable
  if (!store.purge(id)) return false;
  await dropWorktree(conv);
  removeTraces(id);
  broadcast({ type: 'deleted', convId: id });
  return true;
}

app.delete('/api/conversations/:id', asyncRoute(async (req, res) => {
  stopConversation(req.params.id, { forget: true });
  const conv = store.get(req.params.id); // relu avant le retrait : après, il n'y a plus rien
  const detached = store.remove(req.params.id);
  searchService.forget(req.params.id);
  authRequests.forget(req.params.id);
  asks.forget(req.params.id);
  // Les fiches jamais tranchées partent avec la conversation : leur bouton vivait dans le
  // fil. Celles qui ont été gardées restent — elles appartiennent au projet, pas au fil.
  memory.forget(req.params.id);
  const worktree = await dropWorktree(conv);
  removeTraces(req.params.id);
  broadcast({ type: 'deleted', convId: req.params.id });
  // Les enfants survivent au parent : il faut les renvoyer pour que la sidebar les
  // remonte à la racine au lieu de les laisser rattachés à un parent disparu.
  for (const childId of detached) {
    const entry = store.list().find((c) => c.id === childId);
    if (entry) broadcast({ type: 'conversation', conversation: entry });
  }
  res.json({ deleted: true, detached, worktree });
}));

const resolveUsageMeta = (id) => {
  const meta = store.getMeta(id);
  return meta ? { ...meta, project: notes.projectOf(meta) } : null;
};
const workspaceService = workspaceModule.create({
  listConversations: () => store.list().map((conv) =>
    conv.cwd && conv.cwd.startsWith(`${path.join(store.DATA_DIR, 'scratch')}${path.sep}`)
      ? { ...conv, cwd: null, project: null } : conv),
  listFolders: () => store.folders(),
  listAsks: () => asks.list('pending'),
  listSilent: () => silentTurns,
  notesFor: (project) => notes.list(project),
  plansFor: (project) => plans.list(project),
  usageBreakdown: () => usage.breakdown({ resolve: resolveUsageMeta }),
  inventoryWorktrees: () => worktrees.inventory({
    conversations: store.list(), repos: store.folders().map((folder) => folder.cwd).filter(Boolean),
  }),
});
app.use('/api/workspace', workspaceRoutes({
  express, asyncRoute, store, workspace: workspaceService, budgets, worktrees,
  usage, notes, running, broadcast, providers: PROVIDERS,
}));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const code = Number(err.statusCode || err.status);
  const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
  if (status >= 500) console.error(`requête ${req.method} ${req.path} : ${err.message}`);
  res.status(status).json({ error: err.message || 'Erreur interne du serveur' });
});

let nextClientId = 1;

wss.on('connection', (ws) => {
  // Un identifiant par socket, et non par appareil : le second volet est un iframe de la
  // même page, donc une seconde connexion, avec sa propre conversation ouverte.
  const clientId = `c${nextClientId++}`;
  ws.agentHubConvId = null;
  presence.join(clientId);

  ws.send(
    JSON.stringify({
      type: 'hello',
      running: [...running.keys()],
      authRequests: authRequests.list('pending'),
      asks: asks.list('pending'),
      // Un turn muet l'était peut-être déjà avant que ce navigateur n'arrive : le signal ne
      // peut pas n'exister que dans la diffusion, sinon un rechargement l'efface.
      silent: silentTurns,
    })
  );

  // Le seul message que le navigateur envoie : ce qu'il regarde. Tout le reste du protocole
  // va dans l'autre sens.
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // un client qui bafouille ne doit pas faire tomber le serveur
    }
    if (msg && msg.type === 'presence') {
      ws.agentHubConvId = msg.convId ? String(msg.convId) : null;
      presence.update(clientId, { convId: msg.convId, visible: msg.visible });
    }
  });

  ws.on('close', () => presence.leave(clientId));
});

// Un arrêt PM2 ne doit pas perdre les derniers items écrits.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    scheduler.stop();
    await searchService.close();
    store.flush();
    // Chromium verrouille son profil. Le laisser survivre au redemarrage PM2 rendrait la
    // prochaine ouverture impossible, contrairement aux turns dont la survie est voulue.
    await remoteBrowser.close();
    process.exit(0);
  });
}

// L'adresse peut ne pas exister encore : au démarrage, PM2 part parfois avant que
// l'interface d'écoute (VPN, alias) ne soit montée. On attend qu'elle apparaisse.
// Voir `lib/listen.js`, qui dit aussi pourquoi on ne bascule surtout pas sur `0.0.0.0`.
listenWithRetry(server, {
  port: PORT,
  host: HOST,
  onWait: ({ code, attempts, delay }) => {
    // Journalisé à chaque tentative : une attente muette ressemble à une application morte,
    // et c'est justement le symptôme qu'on cherchait à expliquer.
    console.error(
      `écoute impossible sur ${HOST}:${PORT} (${code}, tentative ${attempts}) — ` +
        `nouvel essai dans ${Math.round(delay / 1000)} s` +
        (code === 'EADDRNOTAVAIL' ? " ; l'interface d'écoute est-elle montée ?" : '')
    );
  },
  onListening: ({ attempts }) => {
    console.log(
      `agentHub sur http://${HOST}:${PORT} — données dans ${store.DATA_DIR}` +
        (attempts ? ` (lié après ${attempts} tentative(s))` : '')
    );
    console.log(
      `fuseau ${Intl.DateTimeFormat().resolvedOptions().timeZone}, ` +
        `planificateur toutes les ${Math.round(scheduler.TICK_MS / 1000)} s`
    );

    reconcileOnBoot();
    // Index dérivé, construit hors du thread HTTP ; le serveur reste utilisable pendant
    // le premier passage, et les ouvertures suivantes lisent directement leur fenêtre.
    searchService.warm(store.list());

    // Le balayage des turns muets. Il tourne toujours, y compris quand rien ne tourne : un
    // tick sur une liste vide est une lecture de fichier de quelques centaines d'octets.
    setInterval(sweepSilence, silence.TICK_MS).unref();

    // Le redémarrage a coupé les requêtes MCP que des agents tenaient ouvertes : leurs
    // questions ne débloqueraient plus rien. On les ferme, ce qui fait retomber la suite sur
    // l'arbitrage qui termine le turn.
    const closed = asks.dropWaiters();
    if (closed) console.log(`${closed} question(s) en attente fermée(s) par le redémarrage`);

    // Le planificateur est le premier écrivain d'arrière-plan de l'application : jusqu'ici,
    // toute conversation naissait d'une action humaine. Sans déclencheur configuré, il ne
    // fait rien.
    scheduler.start({
      snapshot: () => ({
        triggers: store.triggers(),
        conversations: store.list(),
        hasChildren: (id) => store.hasChildren(id),
      }),
      save: (trigger, patch) => {
        store.updateTrigger(trigger.id, patch);
        broadcast({ type: 'triggers', triggers: store.triggers() });
      },
      launch: (trigger) => runTrigger(trigger),
      purgeRun: (id) => purgeRun(id),
      sendPlanned: (message) => sendPlanned(message),
    });
  },
});
