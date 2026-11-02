'use strict';

// Notification sortante à la fin d'un turn.
//
// C'est le chaînon manquant des déclencheurs : un agent part à 3 h du matin en autonomie
// totale, et sans ça le seul moyen de savoir qu'il a échoué est d'ouvrir la page.
//
// Pourquoi un webhook sortant et pas le Web Push du navigateur : celui-ci exige un
// contexte sécurisé, or l'app est souvent servie en http (localhost / VPN). C'est la même
// limite qui empêche la dictée d'utiliser le micro du navigateur. Un POST sortant, lui,
// ne dépend de rien côté client et marche téléphone éteint.
//
// La configuration est relue à chaque envoi : changer de sujet ntfy depuis la page de
// réglages ne demande pas de redémarrage. Elle vient de `lib/settings.js`, qui superpose
// `data/settings.json` aux défauts de `config/notify.json`.

const settings = require('./settings');

const TIMEOUT_MS = 8000;

/** Les trois issues possibles d'un turn, telles que `onExit` les conclut. */
const OUTCOMES = ['done', 'error', 'stopped'];

/** Réglages possibles par déclencheur. `inherit` suit la configuration globale. */
const MODES = ['inherit', 'never', 'error', 'always'];

function loadConfig() {
  // `config/notify.json` donne les défauts du dépôt, `data/settings.json` ce que la page de
  // réglages a changé. Pas de fichier du tout : la fonctionnalité est simplement éteinte,
  // ce n'est pas une erreur mais l'état par défaut d'une installation qui n'en veut pas.
  return settings.read('notify');
}

/**
 * Faut-il notifier cette issue ?
 *
 * Le réglage du déclencheur prime sur la liste globale, mais l'interrupteur global reste
 * un interrupteur : `enabled: false` n'envoie rien, quoi que demande un déclencheur.
 */
function shouldNotify(config, outcome, mode) {
  if (!config || !config.enabled) return false;
  switch (mode) {
    case 'never':
      return false;
    case 'always':
      return true;
    case 'error':
      return outcome !== 'done';
    default: {
      const events = Array.isArray(config.events) ? config.events : ['error'];
      return events.includes(outcome);
    }
  }
}

const LABELS = {
  done: 'terminé',
  error: 'en échec',
  stopped: 'interrompu',
  // `ask` n'est pas une issue de turn au sens de `OUTCOMES` : le turn s'est terminé
  // normalement, mais le travail attend une réponse humaine pour repartir.
  ask: 'en attente de ta réponse',
};

function money(value) {
  if (!value) return null;
  return `${value < 0.01 ? value.toFixed(4) : value.toFixed(2)} $`;
}

/**
 * Construit le contenu de la notification. Séparé de l'envoi pour être testable sans
 * réseau, et parce que les deux formats de sortie partagent le même texte.
 */
const TAGS = {
  done: 'white_check_mark',
  error: 'x',
  stopped: 'stop_sign',
  ask: 'question',
};

/** Plafond de ntfy. Le dépasser fait refuser la publication, pas seulement les boutons. */
const MAX_ACTIONS = 3;

/**
 * Boutons de réponse d'une notification d'arbitrage.
 *
 * Répondre demandait d'ouvrir l'application, de retrouver la conversation et de cliquer : trois
 * gestes pour dire « oui », alors que l'agent attend. ntfy sait poser des boutons qui font eux-
 * mêmes la requête HTTP — c'est **le téléphone** qui l'émet, pas le serveur ntfy, et c'est ce
 * qui rend la chose possible ici : le téléphone doit pouvoir joindre l'app (même réseau / VPN).
 *
 * Trois contraintes, toutes vérifiables dans la documentation de ntfy :
 *
 * - **Trois actions au maximum.** Au-delà, ntfy refuse la publication entière — la notification
 *   serait perdue, pas seulement ses boutons. Ce sont donc les **options** qu'on tronque, et
 *   jamais le lien vers l'application : quatre propositions dont trois cliquables et aucun
 *   moyen d'atteindre la quatrième serait le pire des trois états.
 * - `clear: true` referme la notification une fois la réponse partie : sans ça elle reste
 *   affichée et on répond deux fois, ce que le serveur refusera mais qui laisse croire à un
 *   échec.
 * - Une question **sans options** n'a rien à proposer : un bouton libre n'existe pas. Elle ne
 *   reçoit que le lien d'ouverture, ce qui est déjà l'état actuel.
 *
 * Sans `appUrl`, aucun bouton : une action sans URL joignable est un bouton qui échoue en
 * silence, ce qui est pire que pas de bouton du tout.
 */
function askActions(ask, appUrl) {
  if (!ask || !ask.id || !appUrl) return [];
  const base = appUrl.replace(/\/$/, '');
  const actions = (ask.options || []).slice(0, MAX_ACTIONS - 1).map((label) => ({
    action: 'http',
    label,
    url: `${base}/api/asks/${ask.id}/answer`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: label }),
    clear: true,
  }));
  actions.push({ action: 'view', label: 'Ouvrir', url: `${base}/#${ask.convId}`, clear: false });
  return actions;
}

function buildMessage({ conv, outcome, error, appUrl, triggerName, note, ask }) {
  const state = LABELS[outcome] || outcome;
  const title = `${triggerName ? `${triggerName} · ` : ''}Agent ${state}`;

  const lines = [conv.title];
  lines.push(`${conv.provider}${conv.model ? ` · ${conv.model}` : ''} — ${conv.cwd}`);

  // La question elle-même, quand il y en a une : une notification qui dit seulement
  // « on te demande quelque chose » oblige à ouvrir l'app pour savoir quoi.
  if (note) lines.push('', String(note).trim().slice(0, 400));

  const cost = money(conv.lastCostUsd);
  if (cost) lines.push(`Coût du turn : ${cost}`);

  if (error) lines.push('', String(error).trim().slice(0, 400));
  if (appUrl) lines.push('', `${appUrl.replace(/\/$/, '')}/#${conv.id}`);

  return {
    title: title.slice(0, 120),
    message: lines.filter((l) => l !== undefined).join('\n'),
    // ntfy : 4 = haute, 3 = normale. Un échec doit sonner, une réussite non — et une
    // question aussi, puisque rien ne repartira tant qu'elle n'aura pas de réponse.
    priority: outcome === 'done' ? 3 : 4,
    tags: [TAGS[outcome] || 'bell'],
    actions: askActions(ask, appUrl),
  };
}

/**
 * Corps de la requête selon le format.
 *
 * `ntfy` utilise la publication JSON à la racine du serveur, et non un POST texte sur
 * l'URL du sujet : les en-têtes ntfy (`Title`) ne sont pas fiables en UTF-8, et un titre
 * accentué y arrivait déformé. `json` envoie la charge brute, à charge du récepteur.
 */
function buildRequest(config, payload) {
  const headers = { 'Content-Type': 'application/json', ...(config.headers || {}) };

  if (config.format === 'ntfy') {
    if (!config.topic) throw new Error('Le sujet ntfy est requis — page Paramètres, section Notifications');
    return {
      url: (config.url || 'https://ntfy.sh').replace(/\/$/, ''),
      headers,
      body: JSON.stringify({
        topic: config.topic,
        title: payload.title,
        message: payload.message,
        priority: payload.priority,
        tags: payload.tags,
        // Omis quand il n'y a rien à proposer : un tableau vide est accepté, mais autant ne
        // pas publier un champ qui ne veut rien dire.
        ...(payload.actions && payload.actions.length ? { actions: payload.actions } : {}),
      }),
    };
  }

  if (!config.url) throw new Error('L’url du webhook est requise — page Paramètres, section Notifications');
  return { url: config.url, headers, body: JSON.stringify(payload) };
}

/**
 * Envoie la notification. Ne rejette jamais : une notification perdue ne doit pas
 * remonter dans le fil ni faire échouer la fin d'un turn.
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
async function send(context) {
  const config = loadConfig();
  if (!shouldNotify(config, context.outcome, context.mode)) return { sent: false, reason: 'filtré' };

  const payload = {
    // La configuration prime sur l'URL déduite du bind : `appUrl: ""` veut dire « pas de
    // lien », et le bind n'est pas toujours le meilleur nom pour joindre l'app.
    ...buildMessage({ ...context, appUrl: config.appUrl ?? context.appUrl }),
    outcome: context.outcome,
    convId: context.conv.id,
    provider: context.conv.provider,
    triggerId: context.conv.triggerId || null,
  };

  try {
    const request = buildRequest(config, payload);
    const response = await fetch(request.url, {
      method: config.method || 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(config.timeoutMs || TIMEOUT_MS),
    });
    if (!response.ok) {
      const reason = `${response.status} ${response.statusText}`;
      console.error(`notification refusée par ${request.url} : ${reason}`);
      return { sent: false, reason };
    }
    return { sent: true };
  } catch (err) {
    console.error(`notification impossible : ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  send,
  shouldNotify,
  buildMessage,
  buildRequest,
  askActions,
  loadConfig,
  OUTCOMES,
  MODES,
  MAX_ACTIONS,
};
