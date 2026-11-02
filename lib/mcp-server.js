'use strict';

// Le serveur MCP qu'agentHub offre à ses propres agents.
//
// Il n'expose qu'un outil, `ask_user`, et tout son intérêt tient dans une seule propriété :
// **il ne répond pas tout de suite**. L'appel reste suspendu jusqu'à ce qu'un humain
// réponde dans l'interface, puis rend sa réponse comme résultat d'outil. L'agent n'a pas
// interrompu son turn, il a juste attendu — c'est ce que fait la modale native de Claude
// Code, sauf qu'ici c'est agentHub qui sert, donc les autres fournisseurs y ont droit aussi.
//
// Le protocole est implémenté à la main, et volontairement au minimum : quatre méthodes,
// pas de session, pas de flux serveur. Tirer le SDK MCP pour ça mettrait une dépendance et
// un `node_modules` de plus dans une application qui n'a ni build ni framework front.
//
// Transport « streamable HTTP » : le client POSTe du JSON-RPC, on répond en
// `application/json`. La spécification autorise cette forme pour un serveur qui n'a rien à
// pousser de lui-même ; le `text/event-stream` ne sert qu'aux serveurs qui émettent.

const asks = require('./asks');

/** Version de protocole servie par défaut, quand le client n'en annonce pas. */
const DEFAULT_PROTOCOL = '2025-06-18';

const SERVER_NAME = 'agenthub';

/** Nom de l'outil tel que les CLIs le composeront : `mcp__<serveur>__<outil>`. */
const TOOL = 'ask_user';

function toolName(serverName = SERVER_NAME) {
  return `mcp__${serverName}__${TOOL}`;
}

const TOOL_SPEC = {
  name: TOOL,
  title: "Demander un arbitrage à l'utilisateur",
  description:
    "Pose une question à l'utilisateur et ATTEND sa réponse, sans interrompre ton travail. " +
    "À n'employer que devant une décision ambiguë dont un mauvais choix serait coûteux à " +
    'défaire — supprimer des données, choisir une architecture, publier. Pour une préférence ' +
    "réversible, tranche seul. Fais d'abord tout ce qui ne dépend pas de la réponse. " +
    "Renvoie la réponse de l'utilisateur, ou t'avertit que personne n'a répondu à temps.",
  inputSchema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'La question, en une phrase claire.',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description:
          "Propositions de réponse, facultatives, six au plus. L'utilisateur reste libre " +
          "d'écrire autre chose : ce sont des raccourcis, pas un menu fermé.",
      },
      context: {
        type: 'string',
        description: "Ce que tu as déjà fait, pour que la question se comprenne sans relire le fil.",
      },
      convId: {
        type: 'string',
        description:
          "Identifiant de la conversation ($AGENTHUB_CONV_ID). Inutile quand agentHub a " +
          "inscrit le serveur pour une conversation précise ; requis sinon.",
      },
    },
    required: ['question'],
  },
};

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Résultat d'outil au format MCP. `isError` dit à l'agent que ça n'a pas marché. */
function toolText(text, isError) {
  return { content: [{ type: 'text', text }], isError: Boolean(isError) };
}

/**
 * Exécute `ask_user`.
 *
 * @param {object} args        arguments de l'outil
 * @param {string|null} convId conversation portée par l'URL, quand il y en a une
 * @param {object} deps        `{ onCreate, resolveConv, waitMs }` — l'appelant fournit la
 *   diffusion et la validation, ce module ne connaît ni le store ni les websockets
 */
async function callAskUser(args, convId, deps) {
  const spec = args || {};
  const target = String(convId || spec.convId || '').trim();
  if (!target) {
    return toolText(
      "Conversation inconnue : rappelle l'outil en passant convId, la valeur de la variable " +
        "d'environnement AGENTHUB_CONV_ID.",
      true
    );
  }
  if (deps.resolveConv && !deps.resolveConv(target)) {
    return toolText(`Conversation inconnue : ${target}`, true);
  }

  let row;
  try {
    row = asks.create({
      convId: target,
      question: spec.question,
      options: spec.options,
      context: spec.context,
      mode: 'live',
    });
  } catch (err) {
    return toolText(`Demande refusée : ${err.message}`, true);
  }

  if (deps.onCreate) deps.onCreate(row);

  const answered = await asks.waitFor(row.id, deps.waitMs || asks.WAIT_MS);
  if (deps.onSettle) deps.onSettle(asks.get(row.id) || row);

  if (!answered) {
    // Le plafond est atteint. On rend la main plutôt que de laisser le CLI couper l'appel
    // lui-même : l'agent peut alors décider — reposer la question par la voie qui termine
    // le turn, ou continuer sans réponse s'il juge que c'est tenable.
    return toolText(
      "Personne n'a répondu dans le temps imparti. Ne reste pas bloqué : soit tu reposes la " +
        "question par la voie qui termine le turn, soit tu poursuis en expliquant l'hypothèse " +
        'que tu retiens.',
      true
    );
  }
  return toolText(answered.answer);
}

/**
 * Traite un message JSON-RPC. Rend `null` pour une notification, à laquelle il ne faut
 * précisément rien répondre.
 */
async function dispatch(message, convId, deps) {
  const { id, method, params } = message || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      // On renvoie la version demandée par le client quand il en donne une : notre serveur
      // n'utilise que le socle commun à toutes les révisions, et négocier à la baisse ferait
      // échouer des clients pour rien.
      const asked = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
      return rpcResult(id, {
        protocolVersion: asked || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: '1.0.0' },
      });
    }

    // Le client signale qu'il est prêt. Une notification : pas de réponse, pas d'accusé.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return isNotification ? null : rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, { tools: [TOOL_SPEC] });

    case 'tools/call': {
      const name = params && params.name;
      if (name !== TOOL) return rpcError(id, -32602, `Outil inconnu : ${name}`);
      const result = await callAskUser(params && params.arguments, convId, deps);
      return rpcResult(id, result);
    }

    // Déclarées absentes plutôt que laissées en « méthode inconnue » : certains clients
    // sondent ces listes au démarrage et journalisent une erreur pour chacune.
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });

    default:
      return isNotification ? null : rpcError(id, -32601, `Méthode inconnue : ${method}`);
  }
}

module.exports = {
  DEFAULT_PROTOCOL,
  SERVER_NAME,
  TOOL,
  TOOL_SPEC,
  toolName,
  dispatch,
  toolText,
};
