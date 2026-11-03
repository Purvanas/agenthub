'use strict';

// Lance un turn d'agent et traduit son flux JSONL en items de conversation.
//
// Les deux CLIs reçoivent le prompt sur stdin (documenté chez Claude comme chez
// Codex) : ça évite tout problème d'échappement ou de limite d'argv.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const browser = require('./browser');
const secrets = require('./secrets');
const skills = require('./skills');
const inflight = require('./inflight');
const authRequests = require('./auth-requests');
const asks = require('./asks');
const notes = require('./notes');
const plans = require('./plans');
const memory = require('./memory');
const rules = require('./rules');
const panel = require('./panel');
const mcpServer = require('./mcp-server');
const googleOauth = require('./google-oauth');

// Le PATH des agents, et pourquoi il ne peut pas être celui qu'on hérite.
//
// PM2 transmet le PATH de son propre lanceur, où `~/.local/bin` ne figure pas. Or c'est là que
// `pip install --user` dépose ses binaires — yt-dlp, rembg, gallery-dl — et là qu'on pose les
// shims faits à la main. Un shell de connexion l'a, lui, parce que `~/.profile` le préfixe.
//
// D'où un symptôme qui fait perdre un temps fou : l'outil « marche en SSH » et l'agent échoue
// dessus en `exit 127`, souvent au milieu d'un hook git qui ne dit pas quel binaire manquait.
// Mesuré le 03/08/2026 sur un `pre-push` qui appelait `pnpm`.
//
// On reproduit l'ordre du shell de connexion au lieu d'en inventer un : le dossier utilisateur
// d'abord, pour qu'une installation locale prime, comme partout ailleurs sur la machine.
const USER_BIN = path.join(os.homedir(), '.local', 'bin');

/**
 * PATH à donner aux agents : celui du process, avec `~/.local/bin` en tête.
 *
 * Exporté pour être testable — et parce que se tromper ici est silencieux : le PATH n'apparaît
 * dans aucun log, et l'erreur ressemble à un outil cassé plutôt qu'à un outil introuvable.
 *
 * @param {string} [base] PATH de départ, celui du process par défaut
 */
function agentPath(base = process.env.PATH || '') {
  const dirs = base.split(path.delimiter).filter(Boolean);
  return [USER_BIN, ...dirs.filter((dir) => dir !== USER_BIN)].join(path.delimiter);
}

// Un provider = un binaire, une construction d'arguments, un traducteur
// d'événements, et une éventuelle réécriture du prompt. Tout passe par cette table :
// ajouter un agent ne demande pas de toucher à `runTurn`. (Les fonctions citées
// sont déclarées plus bas, les déclarations de fonctions étant remontées.)
//
// Les constructeurs d'arguments reçoivent `(conv, images, turn)`. `turn` porte ce qui
// vaut pour cet appel-là et non pour la conversation : le schéma de sortie demandé et
// les chemins des fichiers temporaires écrits pour lui.
const PROVIDERS = {
  claude: {
    bin: () => process.env.AGENTHUB_CLAUDE_BIN || 'claude',
    args: buildClaudeArgs,
    mapEvent: mapClaudeEvent,
    streamUsage: claudeStreamUsage,
    // Claude Code n'a pas de flag image : on lui donne les chemins, son outil Read
    // lit les images nativement.
    prompt: (text, images) => {
      const pics = imagePaths(images);
      return pics.length
        ? `${text}\n\nImages jointes à ce message (ouvre-les avec Read) :\n${pics
            .map((p) => `- ${p}`)
            .join('\n')}`
        : text;
    },
    // `--fork-session` existe sur `claude --resume` : une conversation enfant peut
    // démarrer avec le contexte complet de son parent.
    canFork: true,
    // Veut sa configuration MCP dans un fichier, là où Codex l'accepte en surcharge `-c`.
    mcpConfigFile: true,
    mcpCapable: true,
  },
  codex: {
    bin: () => process.env.AGENTHUB_CODEX_BIN || 'codex',
    args: buildCodexArgs,
    mapEvent: mapCodexEvent,
    // Codex reçoit les images par `--image`, rien à ajouter au texte.
    prompt: (text) => text,
    // `codex exec resume` n'a pas d'équivalent de `--fork-session` : un relais
    // Codex vers Codex passe donc par la note de passation. Vérifié sur 0.146.0.
    canFork: false,
    // Seul des trois à vouloir le schéma sur disque (`--output-schema <FICHIER>`).
    schemaFile: true,
    mcpCapable: true,
  },
  grok: {
    // Le chemin peut être fixé explicitement quand le gestionnaire de processus n'hérite
    // pas du PATH du shell interactif.
    bin: () => process.env.AGENTHUB_GROK_BIN || 'grok',
    args: buildGrokArgs,
    // Grok Build émet le format de l'API Messages d'Anthropic, identique à celui
    // de Claude Code : même traducteur, sans adaptation.
    mapEvent: mapClaudeEvent,
    // Même relevé intermédiaire, pour la même raison. S'il manque, la reconstitution d'un
    // turn coupé ne trouve rien : elle ne compte alors rien, elle n'invente pas.
    streamUsage: claudeStreamUsage,
    prompt: buildGrokPrompt,
    // Le prompt est écrit dans un fichier temporaire, pas envoyé sur stdin.
    promptFile: true,
    canFork: true,
  },
};

/**
 * Arguments de session pour les CLIs qui suivent la ligne de commande de Claude Code
 * (Claude et Grok). Trois cas : reprendre la session de la conversation, démarrer en
 * forkant celle d'une autre conversation, ou ouvrir une session neuve.
 */
function sessionArgs(conv) {
  if (conv.sessionStarted) return ['--resume', conv.providerSessionId];
  // Fork : on n'impose pas l'identifiant de session de l'enfant. Grok documente la
  // combinaison de `--fork-session` avec `--session-id`, Claude ne la documente pas ;
  // plutôt que de parier, on laisse le CLI nommer la session forkée et on la récupère
  // dans l'événement `init`, ce que `onSession` fait déjà.
  if (conv.forkFrom && PROVIDERS[conv.provider].canFork) {
    return ['--resume', conv.forkFrom, '--fork-session'];
  }
  return ['--session-id', conv.providerSessionId];
}

/**
 * Sortie structurée : le CLI contraint la réponse finale à respecter un schéma JSON.
 *
 * Claude et Grok prennent le schéma en clair sur la ligne de commande et publient l'objet
 * validé dans `structured_output` de leur événement `result`. Codex veut un fichier et ne
 * publie rien : sa réponse finale *est* le JSON, qu'on relit dans `mapCodexEvent`.
 * Mesuré le 01/08/2026 sur les trois. Chez Grok, `--json-schema` est documenté comme
 * impliquant `--output-format json` — vérifié : un `--output-format` explicite prime, le
 * flux reste celui qu'on attend.
 */
function schemaArgs(turn) {
  if (!turn || !turn.schema) return [];
  if (turn.schemaPath) return ['--output-schema', turn.schemaPath];
  return ['--json-schema', JSON.stringify(turn.schema)];
}

/**
 * Branche les serveurs MCP de ce turn : celui d'agentHub, et le navigateur s'il est demandé.
 *
 * Deux voies selon le CLI. Claude veut un fichier de configuration
 * (`--mcp-config <fichier>`) ; on ne passe pas `--strict-mcp-config` avec, sinon les
 * serveurs MCP déjà configurés du compte disparaîtraient pour ce turn. Codex accepte une
 * surcharge de config en ligne (`-c`), à la même clé que celle qu'écrit `codex mcp add`.
 *
 * Grok n'a aucune des deux : voir `lib/browser.js`. Il garde donc l'arbitrage qui termine
 * le turn, et n'obtiendrait `ask_user` qu'inscrit globalement, à la main.
 */
function mcpArgs(conv, turn) {
  const servers = (turn && turn.mcp) || {};
  const names = Object.keys(servers);
  if (!names.length) return [];
  if (turn.mcpPath) return ['--mcp-config', turn.mcpPath];

  // Codex : une surcharge par clé, à l'endroit même où `codex mcp add` écrirait. L'URL
  // n'est pas du TOML valide, et Codex documente la retombée en chaîne littérale.
  const args = [];
  for (const name of names) {
    args.push('-c', `mcp_servers.${name}.url=${servers[name].url}`);
    // Notre serveur retient l'appel le temps qu'un humain réponde : sans ce relèvement,
    // Codex couperait bien avant.
    if (servers[name].holdsLong) {
      args.push('-c', `mcp_servers.${name}.tool_timeout_sec=${cliTimeoutSeconds()}`);
    }
  }
  return args;
}

/** Racine du serveur MCP d'agentHub, à laquelle s'ajoute l'identifiant de conversation. */
function mcpBaseUrl() {
  return process.env.AGENTHUB_MCP_URL || `${agentHubBaseUrl()}/mcp`;
}

/** URL interne du processus, dérivée des mêmes réglages que le serveur HTTP. */
function agentHubBaseUrl() {
  const host = process.env.HOST || '127.0.0.1';
  const port = process.env.PORT || 3901;
  return `http://${host}:${port}`;
}

/**
 * Plafond d'appel d'outil imposé aux CLIs, en secondes.
 *
 * Toujours **plus long que notre propre attente** : on veut expirer les premiers et rendre
 * à l'agent un message exploitable, plutôt que de le laisser recevoir l'échec opaque d'un
 * appel coupé par son CLI.
 */
function cliTimeoutSeconds() {
  return Math.ceil((asks.WAIT_MS + asks.CLI_MARGIN_MS) / 1000);
}

/**
 * Serveurs MCP donnés à ce turn.
 *
 * Le nôtre y est **toujours**, pour les fournisseurs qui savent en recevoir un à l'appel :
 * c'est lui qui porte `ask_user`, et une question ne se prévoit pas à la création d'une
 * conversation. Le navigateur, lui, ne vient que si elle l'a demandé.
 */
function mcpServersFor(conv, turn) {
  const servers = {};
  servers[mcpServer.SERVER_NAME] = {
    type: 'http',
    url: `${mcpBaseUrl().replace(/\/$/, '')}/${conv.id}`,
    // Interne, jamais sérialisé vers un CLI : voir `mcpConfigJson`.
    holdsLong: true,
  };
  if (turn && turn.browser) Object.assign(servers, browser.mcpServers().mcpServers);
  return servers;
}

/**
 * La configuration telle qu'un CLI la lit, débarrassée de nos marqueurs internes.
 *
 * **Ne pas y remettre de clé `timeout` par serveur.** Essayé le 05/08/2026 pour dépasser les
 * cinq minutes d'attente : le binaire de Claude décrit bien une clé par serveur comme un
 * « hard wall-clock limit per call », et le plafond de requête HTTP comme *« Capped at
 * 5 minutes … Ignored when `timeout` is also set »*. La clé est acceptée — le serveur MCP
 * charge, l'outil répond — mais **elle ne lève pas le plafond** : mesuré avec `timeout` à
 * 10 min 30 *et* `MCP_TOOL_TIMEOUT` à la même valeur, l'appel a été coupé entre 5 et 6
 * minutes, comme sans elle. Soit ce n'est pas le bon nom et zod l'écarte en silence, soit un
 * autre plafond de cinq minutes s'applique en amont.
 */
function mcpConfigJson(servers) {
  const out = {};
  for (const [name, spec] of Object.entries(servers)) {
    const { holdsLong, ...rest } = spec;
    out[name] = rest;
  }
  return { mcpServers: out };
}

function buildClaudeArgs(conv, images, turn) {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // Sans ce drapeau, un sous-agent est à moitié muet : ses appels d'outils remontent
    // bien (portant un `parent_tool_use_id`), mais ni son raisonnement ni sa réponse.
    // Mesuré le 01/08/2026 sur claude 2.1.220, avec et sans, sur le même prompt.
    // Les deltas restent ceux du parent — le texte du sous-agent n'arrive qu'en message
    // complet — donc la bulle de streaming n'est pas polluée.
    '--forward-subagent-text',
    '--permission-mode',
    'bypassPermissions',
  ];
  if (conv.model) args.push('--model', conv.model);
  if (conv.effort) args.push('--effort', conv.effort);
  args.push(...schemaArgs(turn));
  args.push(...mcpArgs(conv, turn));
  args.push(...sessionArgs(conv));
  return args;
}

function buildCodexArgs(conv, images, turn) {
  const common = [
    '--json',
    '--dangerously-bypass-approvals-and-sandbox',
    '--skip-git-repo-check',
  ];
  if (conv.model) common.push('--model', conv.model);
  // Codex n'a pas de flag dédié : l'effort passe par une surcharge de config.
  if (conv.effort) common.push('-c', `model_reasoning_effort=${conv.effort}`);
  common.push(...schemaArgs(turn));
  common.push(...mcpArgs(conv, turn));
  // Un .json passé à `--image` fait échouer le turn : Codex n'accepte que des images.
  for (const image of imagePaths(images)) common.push('--image', image);
  if (conv.sessionStarted && conv.providerSessionId) {
    // `resume` n'accepte pas --cd : le cwd du process suffit.
    return ['exec', 'resume', conv.providerSessionId, ...common, '-'];
  }
  return ['exec', ...common, '--cd', conv.cwd, '-'];
}

const GROK_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function buildGrokArgs(conv, images, turn) {
  const args = [
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    // Chaque turn est un process isolé : sans ça, Grok délègue à un « leader »
    // partagé, et c'est ce qui faisait échouer la lecture du prompt.
    '--no-leader',
    // Le prompt passe par un fichier et non par stdin : les blocs ACP portent les
    // images en base64, ce qui dépasse vite la limite de 128 Ko par argument, et
    // `/dev/stdin` n'est pas lisible depuis le process que Grok finit par exécuter.
    '--prompt-file',
    turn.promptPath,
  ];
  if (conv.model) args.push('--model', conv.model);
  if (conv.effort) args.push('--reasoning-effort', conv.effort);
  args.push(...schemaArgs(turn));
  args.push(...sessionArgs(conv));
  return args;
}

/**
 * Prompt de Grok : des blocs de contenu ACP (`{type,text}` et
 * `{type,data,mimeType}`), et non le format Anthropic — malgré une sortie qui suit,
 * elle, le format Anthropic.
 */
function buildGrokPrompt(text, images) {
  const blocks = [{ type: 'text', text }];
  for (const file of imagePaths(images)) {
    const mimeType = GROK_MIME[path.extname(file).toLowerCase()];
    if (!mimeType) continue;
    try {
      blocks.push({
        type: 'image',
        data: fs.readFileSync(file).toString('base64'),
        mimeType,
      });
    } catch (err) {
      console.error(`image illisible pour Grok (${file}) : ${err.message}`);
    }
  }
  return JSON.stringify(blocks);
}

// --- Traduction des événements -------------------------------------------

function mapClaudeEvent(evt, ctx) {
  const out = [];

  if (evt.type === 'system' && evt.subtype === 'init') {
    if (evt.session_id) ctx.session(evt.session_id);
    // Le CLI publie ici les commandes en « / » qu'il accepte, plugins compris. C'est la
    // seule source qui ne peut pas mentir, puisque c'est celle du programme qui les
    // exécute — et elle ne coûte rien, l'événement arrive de toute façon.
    if (Array.isArray(evt.slash_commands)) {
      ctx.skills({ commands: evt.slash_commands, plugins: evt.plugins });
    }
    return out;
  }

  if (evt.type === 'system' && evt.subtype === 'api_retry') {
    // Inutile d'attendre les 10 tentatives : un 401 ne se résoudra pas tout seul.
    if (evt.error === 'authentication_failed' || evt.error === 'oauth_org_not_allowed') {
      ctx.fatal(
        "Claude Code n'est plus authentifié sur la machine hôte (401). " +
          'Ouvre un terminal sur cette machine, lance `claude`, puis `/login`.'
      );
      return out;
    }
    if (evt.error === 'billing_error') {
      ctx.fatal('Problème de facturation sur le compte Claude (voir claude.ai/settings/billing).');
      return out;
    }
    out.push({
      kind: 'notice',
      text: `Nouvelle tentative ${evt.attempt}/${evt.max_retries} (${evt.error}) dans ${Math.round(
        evt.retry_delay_ms
      )} ms`,
    });
    return out;
  }

  // Streaming token par token : purement visuel, jamais persisté.
  if (evt.type === 'stream_event') {
    const e = evt.event || {};
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && e.delta.text) ctx.delta(e.delta.text);
      else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
        ctx.delta(e.delta.thinking, 'thinking');
      }
    }
    return out;
  }

  if (evt.type === 'assistant' && evt.message) {
    // Les messages de sous-agents portent un parent_tool_use_id non nul.
    const nested = Boolean(evt.parent_tool_use_id);
    for (const block of evt.message.content || []) {
      if (block.type === 'text' && block.text.trim()) {
        out.push({ kind: 'text', text: block.text, nested });
      } else if (block.type === 'thinking' && block.thinking) {
        out.push({ kind: 'thinking', text: block.thinking, nested });
      } else if (block.type === 'tool_use') {
        out.push({
          kind: 'tool',
          tool: block.name,
          toolUseId: block.id,
          input: block.input,
          nested,
        });
      }
    }
    return out;
  }

  if (evt.type === 'user' && evt.message) {
    for (const block of evt.message.content || []) {
      if (block.type === 'tool_result') {
        ctx.toolResult(block.tool_use_id, block.content, block.is_error);
      }
    }
    return out;
  }

  if (evt.type === 'result') {
    out.push({
      kind: 'result',
      isError: Boolean(evt.is_error),
      subtype: evt.subtype,
      text: evt.is_error ? evt.result || evt.error || 'Échec du turn' : null,
      costUsd: evt.total_cost_usd || 0,
      durationMs: evt.duration_ms || 0,
      numTurns: evt.num_turns || 0,
      // Claude Code chiffre lui-même l'équivalent API, par modèle : on n'a
      // aucune table de prix à maintenir de notre côté.
      modelUsage: evt.modelUsage || null,
      usage: evt.usage || null,
      // Présent uniquement quand un schéma a été demandé : l'objet déjà validé par le CLI.
      structuredOutput: evt.structured_output || null,
    });
    return out;
  }

  return out;
}

/**
 * Relevé de consommation porté par un événement intermédiaire de Claude.
 *
 * Le CLI publie l'usage de chaque appel API sur ses événements `assistant`, modèle compris.
 * Piège vérifié le 03/08/2026 : il émet un événement **par bloc de contenu** — une réflexion
 * puis deux appels d'outils font trois événements portant le même `message.id` et le même
 * relevé. Sommer les événements comptait donc le même appel jusqu'à trois fois, d'où
 * l'identifiant rendu ici : c'est à l'appelant de dédupliquer.
 *
 * @returns {{id: string|null, model: string|null, usage: object}|null}
 */
function claudeStreamUsage(evt) {
  if (evt.type !== 'assistant' || !evt.message || !evt.message.usage) return null;
  const usage = evt.message.usage;
  const creation = usage.cache_creation || {};
  return {
    id: evt.message.id || null,
    model: evt.message.model || null,
    usage: {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheCreationInputTokens: usage.cache_creation_input_tokens || 0,
      // L'écriture de cache a deux tarifs selon la durée demandée : le partage est ici, et
      // nulle part ailleurs — le relevé final du turn ne le donne pas.
      cacheCreation1hInputTokens: creation.ephemeral_1h_input_tokens || 0,
      cacheReadInputTokens: usage.cache_read_input_tokens || 0,
    },
  };
}

/**
 * Consommation d'un turn qui n'a pas rendu son relevé final.
 *
 * Un turn tué par un redémarrage ou par une interruption n'émet jamais l'événement `result`
 * qui porte le relevé du CLI : ses tokens n'étaient comptés nulle part, et c'est ce qui
 * faisait paraître la consommation figée un matin passé à redémarrer agentHub. On relit donc
 * le flux et on additionne les relevés intermédiaires, par modèle.
 *
 * Relire le fichier entier plutôt que de cumuler au fil de l'eau est délibéré : la reprise
 * après redémarrage repart d'un offset, donc un cumul gardé en mémoire aurait perdu tout ce
 * qui précédait l'arrêt. Ici, une lecture, une seule fois, et seulement quand le turn a mal
 * fini — le chemin normal ne paie rien.
 *
 * @param {string|object} provider  nom du fournisseur, ou son entrée déjà résolue
 * @returns {object|null} un `modelUsage` à la forme de celui de Claude, ou null si rien à compter
 */
function partialUsage(convId, provider) {
  const entry = typeof provider === 'string' ? PROVIDERS[provider] : provider;
  if (!entry || !entry.streamUsage) return null;
  let raw;
  try {
    raw = fs.readFileSync(inflight.outPath(convId), 'utf8');
  } catch {
    return null; // flux déjà nettoyé, ou turn qui n'a jamais écrit
  }

  const perModel = new Map();
  const counted = new Set();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const found = entry.streamUsage(evt);
    if (!found) continue;
    if (found.id) {
      if (counted.has(found.id)) continue;
      counted.add(found.id);
    }
    const model = found.model || 'défaut';
    if (!perModel.has(model)) perModel.set(model, {});
    const target = perModel.get(model);
    for (const [field, value] of Object.entries(found.usage)) {
      target[field] = (target[field] || 0) + value;
    }
  }

  if (!perModel.size) return null;
  return Object.fromEntries(perModel);
}

/**
 * Sépare le texte et les images d'un résultat d'outil.
 *
 * Un serveur MCP de navigateur renvoie ses captures d'écran comme blocs image, à côté du
 * texte. Aplatir le contenu — ce que faisait `content.map((c) => c.text)` — les
 * transformait en chaînes vides : l'agent voyait la page, l'utilisateur non.
 *
 * Deux formes d'image circulent. Claude et Grok réemballent au format Anthropic
 * (`source: {media_type, data}`), Codex passe le bloc MCP tel quel (`{mimeType, data}`).
 * On accepte les deux plutôt que de parier sur l'une.
 *
 * @returns {{text: string, images: Array<{mime: string, base64: string}>}}
 */
function splitToolContent(content) {
  if (content == null) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };

  if (!Array.isArray(content)) {
    const text = content.text || content.message || '';
    return { text: text || JSON.stringify(content), images: [] };
  }

  const parts = [];
  const images = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      if (block != null) parts.push(String(block));
      continue;
    }
    if (block.type === 'image') {
      const source = block.source || block;
      const base64 = source.data;
      const mime = source.media_type || source.mimeType || block.mimeType;
      if (typeof base64 === 'string' && base64) images.push({ mime: mime || 'image/png', base64 });
      continue;
    }
    if (typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    // Bloc d'un type qu'on ne connaît pas : on le montre brut plutôt que de le perdre.
    parts.push(JSON.stringify(block));
  }
  return { text: parts.join('\n'), images };
}

/** @returns {*} l'objet, ou null si ce n'est pas du JSON — jamais d'exception. */
function parseJson(text) {
  try {
    const value = JSON.parse(text);
    return value === null ? null : value;
  } catch {
    return null;
  }
}

function codexText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(codexText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return value.text || value.message || value.content || '';
  }
  return '';
}

// Le schéma d'événements de Codex a bougé entre versions : on gère la forme
// actuelle (thread.started / item.completed / turn.completed) et l'ancienne
// enveloppe {id, msg:{type}}, et on ignore proprement ce qu'on ne connaît pas.
function mapCodexEvent(evt, ctx) {
  const out = [];
  const type = evt.type || (evt.msg && evt.msg.type) || '';
  const body = evt.msg || evt;

  const sid =
    evt.thread_id ||
    evt.session_id ||
    evt.conversation_id ||
    body.thread_id ||
    body.session_id ||
    body.conversation_id;
  if (sid) ctx.session(sid);

  switch (type) {
    case 'thread.started':
    case 'session.created':
    case 'session_configured':
      return out;

    case 'agent_message':
    case 'agent_message_delta':
      if (type.endsWith('delta')) {
        ctx.delta(codexText(body.delta || body.message));
        return out;
      }
      out.push({ kind: 'text', text: codexText(body.message || body) });
      return out;

    case 'agent_reasoning':
    case 'agent_reasoning_delta':
      out.push({ kind: 'thinking', text: codexText(body.text || body.delta) });
      return out;

    case 'turn.started':
    case 'item.started':
    case 'item.updated':
      return out;

    case 'item.completed': {
      const item = evt.item || body.item || {};
      const itype = item.type || item.item_type;
      if (itype === 'agent_message' || itype === 'assistant_message') {
        const text = codexText(item.text || item.message);
        // Codex n'a pas d'équivalent de `structured_output` : avec `--output-schema`, sa
        // réponse finale *est* le JSON. On la met de côté pour le résultat du turn, sans
        // écraser une réponse valide par une tentative ratée qui la suivrait.
        if (ctx.schema) {
          const parsed = parseJson(text);
          if (parsed !== null) ctx.state.structured = parsed;
        }
        out.push({ kind: 'text', text });
      } else if (itype === 'reasoning') {
        const text = codexText(item.text || item.summary);
        if (text) out.push({ kind: 'thinking', text });
      } else if (itype === 'command_execution') {
        out.push({
          kind: 'tool',
          tool: 'Bash',
          input: { command: item.command, cwd: item.cwd },
          result: codexText(item.aggregated_output || item.output),
          isError: item.exit_code != null && item.exit_code !== 0,
        });
      } else if (itype === 'file_change' || itype === 'patch_apply') {
        const files = (item.changes || item.files || [])
          .map((c) => c.path || c)
          .join(', ');
        out.push({ kind: 'tool', tool: 'Edit', input: { files }, result: item.status });
      } else if (itype === 'mcp_tool_call') {
        // Contrairement aux autres, cet item arrive complet : le résultat est là, donc
        // c'est ici qu'il faut en extraire les images. `resultImages` porte le base64
        // jusqu'à l'appelant, seul à savoir écrire sur disque.
        const { text, images } = splitToolContent(item.result);
        out.push({
          kind: 'tool',
          tool: `mcp:${item.server || '?'}/${item.tool || '?'}`,
          input: item.arguments,
          result: text,
          resultImages: images.length ? images : undefined,
        });
      } else if (itype === 'web_search') {
        out.push({ kind: 'tool', tool: 'WebSearch', input: { query: item.query } });
      } else if (itype === 'error') {
        out.push({ kind: 'result', isError: true, text: codexText(item.message || item) });
      }
      return out;
    }

    case 'turn.completed':
    case 'task_complete': {
      const usage = evt.usage || body.usage || {};
      out.push({
        kind: 'result',
        isError: false,
        // Codex ne chiffre rien : le coût est calculé depuis config/pricing.json.
        costUsd: 0,
        durationMs: 0,
        codexUsage: {
          inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
          outputTokens: usage.output_tokens || usage.completion_tokens || 0,
          cacheReadTokens: usage.cached_input_tokens || usage.cache_read_input_tokens || 0,
        },
        structuredOutput: ctx.state.structured || null,
      });
      return out;
    }

    // Codex se sert du type `error` aussi bien pour des avertissements bénins
    // (troncature des descriptions de skills) que pour des échecs. On le remonte
    // donc en simple avis : c'est `turn.failed` qui fait autorité sur l'échec.
    case 'error':
    case 'stream_error':
      out.push({
        kind: 'notice',
        text: codexText(body.message || body.error || evt.error) || 'Avertissement Codex',
      });
      return out;

    case 'turn.failed':
    case 'turn.aborted':
      out.push({
        kind: 'result',
        isError: true,
        text: codexText(body.message || body.error || evt.error) || 'Échec du turn Codex',
      });
      return out;

    default:
      if (type) console.log(`[codex] événement non géré: ${type}`);
      return out;
  }
}

// --- Pièces jointes -------------------------------------------------------

// Le texte n'entre pas dans le prompt : un JSON entier noierait le contexte, alors
// que l'agent n'en lit souvent qu'une clé. On le dépose dans le projet, et il l'ouvre
// avec Read — en entier, ou seulement les lignes qui l'intéressent.
const PIECES_DIR = path.join('.agenthub', 'pieces-jointes');

const TEXT_EXT = new Set(['.md', '.json', '.markdown']);

/**
 * Une pièce jointe arrive tantôt comme un chemin (les images, depuis toujours),
 * tantôt comme `{path, name, kind}` quand on connaît le nom d'origine.
 * @param {string|{path: string, name?: string, kind?: string}} item
 * @returns {{path: string, name: string, kind: 'image'|'text'}|null}
 */
function normalizeAttachment(item) {
  if (typeof item === 'string' && item) {
    return { path: item, name: path.basename(item), kind: kindFromExt(item) };
  }
  if (item && typeof item.path === 'string' && item.path) {
    const kind = item.kind === 'text' || item.kind === 'image' ? item.kind : kindFromExt(item.path);
    return { path: item.path, name: item.name || path.basename(item.path), kind };
  }
  return null;
}

function kindFromExt(file) {
  return TEXT_EXT.has(path.extname(file).toLowerCase()) ? 'text' : 'image';
}

/** Chemins d'images seulement : c'est tout ce que `--image` et les blocs image acceptent. */
function imagePaths(items) {
  return (items || []).map(normalizeAttachment).filter((item) => item && item.kind === 'image').map((item) => item.path);
}

/** Nom montré à l'agent : sans guillemet ni saut de ligne, qui casseraient le balisage. */
function attachmentLabel(name, filePath) {
  const raw = String(name || path.basename(filePath) || 'fichier');
  return raw.replace(/[\r\n\t"<>&]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'fichier';
}

/**
 * Nom de fichier sûr, tiré du nom d'origine. Jamais un chemin : `../` et les
 * séparateurs sont retirés, sinon un nom choisi par l'utilisateur sortirait du dossier.
 * @param {string} name
 * @param {string} filePath
 */
function safePieceName(name, filePath) {
  const raw = path.basename(String(name || path.basename(filePath) || 'fichier'));
  let base = raw.replace(/[\0-\x1f\\/]/g, '').trim();
  if (!base || base === '.' || base === '..') base = 'fichier';
  const ext = path.extname(base).toLowerCase();
  if (!TEXT_EXT.has(ext)) {
    const fromSource = path.extname(filePath).toLowerCase();
    if (TEXT_EXT.has(fromSource)) base += fromSource === '.markdown' ? '.md' : fromSource;
  }
  if (base.length > 80) {
    const suffix = path.extname(base);
    base = base.slice(0, Math.max(1, 80 - suffix.length)) + suffix;
  }
  return base;
}

/**
 * Copie le fichier dans le dossier de travail, sous un nom qui n'écrase rien.
 * Le dossier est ignoré de git : un import ne doit pas apparaître comme du travail
 * à committer. Sans dossier de projet utilisable, on garde le chemin d'origine.
 *
 * @param {{path: string, name: string}} file
 * @param {string} [cwd]
 * @returns {string} chemin à donner à l'agent, relatif au projet quand c'est possible
 */
function importPiece(file, cwd) {
  if (!cwd) return file.path;
  const root = path.resolve(cwd);
  let rootStat;
  try {
    rootStat = fs.statSync(root);
  } catch {
    return file.path;
  }
  if (!rootStat.isDirectory()) return file.path;

  const dir = path.resolve(root, PIECES_DIR);
  if (dir !== root && !dir.startsWith(root + path.sep)) return file.path;
  fs.mkdirSync(dir, { recursive: true });
  const gitignore = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, '*\n');

  const label = safePieceName(file.name, file.path);
  const ext = path.extname(label);
  const stem = ext ? label.slice(0, -ext.length) : label;
  let destName = label;
  for (let n = 2; n < 100 && fs.existsSync(path.join(dir, destName)); n += 1) {
    destName = `${stem}-${n}${ext}`;
  }
  if (fs.existsSync(path.join(dir, destName))) {
    destName = `${stem}-${crypto.randomBytes(3).toString('hex')}${ext}`;
  }

  const dest = path.resolve(dir, destName);
  if (!dest.startsWith(dir + path.sep)) return file.path;
  fs.copyFileSync(file.path, dest);
  return path.relative(root, dest);
}

/**
 * Annonce les fichiers texte joints sans en recopier le contenu. L'agent les lit
 * lui-même, en entier ou en partie.
 *
 * @param {string} text
 * @param {Array<string|{path: string, name?: string, kind?: string}>} [items]
 * @param {string} [cwd] dossier de travail de la conversation
 * @returns {string}
 */
function appendAttachedFiles(text, items, cwd) {
  const files = (items || []).map(normalizeAttachment).filter((item) => item && item.kind === 'text');
  if (!files.length) return text;

  const lines = files.map((file) => {
    const label = attachmentLabel(file.name, file.path);
    let where = file.path;
    try {
      where = importPiece(file, cwd);
    } catch (err) {
      console.error(`pièce jointe non importée (${file.path}) : ${err.message}`);
    }
    return `- ${label} → ${where}`;
  });

  return (
    `${text}\n\nFichiers joints à ce message, copiés dans le projet. ` +
    `Leur contenu n’est pas dans ce message : ouvre-les avec Read, en entier ou seulement la partie utile. ` +
    `Ne les commit pas.\n${lines.join('\n')}`
  );
}

// --- Exécution ------------------------------------------------------------

/**
 * @param {object} conv  conversation (mutée uniquement par le caller)
 * @param {string} prompt
 * @param {object} handlers { onItem, onDelta, onSession, onExit, onStderr }
 * @param {Array<string|{path: string, name?: string, kind?: string}>} [images]
 * @param {{schema?: object}} [options] schéma JSON auquel contraindre la réponse finale
 */
function runTurn(conv, prompt, handlers, images, options) {
  const provider = PROVIDERS[conv.provider];
  if (!provider) throw new Error(`Provider inconnu : ${conv.provider}`);

  const opts = options || {};
  const bin = provider.bin();

  // Les clés des secrets du projet sont annoncées à chaque turn : l'agent ne peut pas se
  // souvenir d'une session à l'autre, et un turn repris après un redémarrage n'a rien lu.
  // Le bloc est ajouté au prompt *envoyé*, pas au message stocké dans le fil : celui-ci
  // reste ce que l'utilisateur a écrit.
  // Une skill demandée par `/nom` est déroulée ici pour les fournisseurs qui ne savent pas
  // le faire — Codex aujourd'hui. Avant l'ajout des secrets : le bloc des clés doit rester
  // en fin de prompt, là où l'agent le lit en dernier.
  const withSkill = skills.expand(conv.provider, prompt, conv.cwd);
  // Le texte joint entre ici, avant les blocs de contexte : ceux-ci doivent rester en
  // fin de prompt. Les images, elles, restent des chemins — chaque CLI les transmet
  // à sa façon, plus bas.
  const withFiles = appendAttachedFiles(withSkill, images, conv.cwd);
  const pics = imagePaths(images);
  // L'outil n'est annoncé qu'aux fournisseurs qui vont réellement le recevoir : promettre
  // `ask_user` à Grok le ferait chercher un outil absent au lieu d'employer le `curl`.
  const askTool = provider.mcpCapable ? mcpServer.toolName() : null;
  const withSecrets =
    `${withFiles}${secrets.promptBlock(conv.folder)}${authRequests.promptBlock()}` +
    `${asks.promptBlock(askTool)}${rules.promptBlock(notes.projectOf(conv))}` +
    `${notes.promptBlock(notes.projectOf(conv))}` +
    `${plans.promptBlock(notes.projectOf(conv))}` +
    `${memory.promptBlock(notes.projectOf(conv))}${panel.promptBlock()}` +
    `${googleOauth.promptBlock()}`;
  const text = provider.prompt(withSecrets, pics);

  // Fichiers temporaires du turn, supprimés à sa sortie : le prompt pour les providers
  // qui ne le lisent pas sur stdin, le schéma pour ceux qui l'attendent sur disque.
  const temps = [];
  const tempFile = (suffix, content) => {
    const file = path.join(
      os.tmpdir(),
      `agenthub-${conv.provider}-${crypto.randomUUID()}${suffix}`
    );
    fs.writeFileSync(file, content, { mode: 0o600 });
    temps.push(file);
    return file;
  };

  const turn = {
    schema: opts.schema || null,
    // Le navigateur n'est branché que si la conversation le demande *et* que le
    // fournisseur sait le recevoir à l'appel — Grok ne sait pas.
    browser: conv.browser && browser.supports(conv.provider) ? browser.config() : null,
    promptPath: null,
    schemaPath: null,
    mcpPath: null,
    mcp: null,
  };
  if (provider.promptFile) turn.promptPath = tempFile('.json', text);
  if (turn.schema && provider.schemaFile) {
    turn.schemaPath = tempFile('.schema.json', JSON.stringify(turn.schema));
  }
  if (provider.mcpCapable) {
    turn.mcp = mcpServersFor(conv, turn);
    if (provider.mcpConfigFile) {
      turn.mcpPath = tempFile('.mcp.json', JSON.stringify(mcpConfigJson(turn.mcp)));
    }
  }

  const args = provider.args(conv, pics, turn);

  // Le flux du CLI va dans un FICHIER, pas dans un tuyau. C'est ce qui rend un turn
  // survivable : un tuyau meurt avec le processus qui le lit, un fichier non. Mesuré le
  // 03/08/2026 — avec un tuyau, un `pm2 restart` perdait le turn ; le CLI maintenu en vie
  // par `treekill: false` se bloquait à la première écriture, n'ayant plus de lecteur.
  const outPath = inflight.outPath(conv.id);
  const errPath = inflight.errPath(conv.id);
  fs.writeFileSync(outPath, ''); // un turn par conversation : on repart d'un fichier vide
  fs.writeFileSync(errPath, '');
  const outFd = fs.openSync(outPath, 'a');
  const errFd = fs.openSync(errPath, 'a');

  let child;
  try {
    child = spawn(bin, args, {
      cwd: conv.cwd,
      detached: true, // pour pouvoir tuer tout le groupe de process
      // Les secrets du projet entrent par l'environnement, et par là seulement : c'est le
      // seul chemin qui les rend utilisables sans les faire passer par le contexte du modèle.
      env: {
        ...process.env,
        ...secrets.env(conv.folder),
        // Après les secrets, délibérément : un projet n'a pas à pouvoir amputer le PATH de
        // l'agent par un `PATH=` dans son `.env`, ce qui casserait tous ses outils d'un coup.
        PATH: agentPath(),
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        AGENTHUB_CONV_ID: conv.id,
        AGENTHUB_AUTH_REQUEST_URL:
          process.env.AGENTHUB_AUTH_REQUEST_URL ||
          `${agentHubBaseUrl()}/api/connections/requests`,
        AGENTHUB_ASK_URL:
          process.env.AGENTHUB_ASK_URL || `${agentHubBaseUrl()}/api/asks`,
        AGENTHUB_NOTES_URL:
          process.env.AGENTHUB_NOTES_URL || `${agentHubBaseUrl()}/api/notes`,
        AGENTHUB_RULES_URL:
          process.env.AGENTHUB_RULES_URL || `${agentHubBaseUrl()}/api/rules`,
        AGENTHUB_PLANS_URL:
          process.env.AGENTHUB_PLANS_URL || `${agentHubBaseUrl()}/api/plans`,
        // Le panneau d'administration, en lecture seule. Le jeton entre par l'environnement
        // comme les secrets d'un projet : c'est le seul chemin qui le rend utilisable sans le
        // faire passer par le contexte du modèle. Chaînes vides quand il n'y a pas de jeton —
        // le bloc de prompt est alors absent, et l'agent n'a rien à quoi se raccrocher.
        ADMINPANEL_URL: panel.available() ? panel.BASE : '',
        ADMINPANEL_TOKEN: panel.token() || '',
        // Plafond d'appel d'outil MCP, en millisecondes. Chez Claude, c'est la seule voie
        // dont le nom soit certain — la clé équivalente par serveur existe dans son
        // binaire, mais son nom exact n'est pas vérifiable sans dépenser un turn, et se
        // tromper de clé dans une config validée est le genre d'échec silencieux qu'on
        // paie deux jours plus tard. Sans ce relèvement, `ask_user` serait coupé bien
        // avant qu'un humain ait vu la question.
        MCP_TOOL_TIMEOUT: String(asks.WAIT_MS + asks.CLI_MARGIN_MS),
        AGENTHUB_GOOGLE_API_URL:
          process.env.AGENTHUB_GOOGLE_API_URL ||
          `${agentHubBaseUrl()}/api/connections/google/api`,
      },
      stdio: ['pipe', outFd, errFd],
    });
  } finally {
    // Le descripteur appartient à l'enfant dès le spawn : le garder ouvert ici empêcherait
    // de savoir que le fichier n'a plus d'écrivain.
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }

  child.stdin.on('error', () => {}); // l'agent peut fermer stdin avant nous
  child.stdin.end(turn.promptPath ? '' : text);

  inflight.open({
    convId: conv.id,
    pid: child.pid,
    provider: conv.provider,
    modelSelection: opts.modelSelection || null,
  });

  const cleanupTemps = () => {
    for (const file of temps) fs.rmSync(file, { force: true });
  };

  const state = follow({
    convId: conv.id,
    provider,
    handlers,
    schema: turn.schema,
    offset: 0,
    kill: () => killTree(child.pid),
    alive: () => child.exitCode === null && child.signalCode === null,
    done: ({ code, stderr, fatalReported }) => {
      cleanupTemps();
      inflight.close(conv.id);
      handlers.onExit(code, stderr, fatalReported);
    },
  });

  child.on('error', (err) => {
    cleanupTemps();
    inflight.close(conv.id);
    state.finish(-1, `${bin} introuvable : ${err.message}`);
  });
  // `exit` et non `close` : les flux ne sont plus les nôtres, il n'y a rien à attendre après
  // la sortie du processus — tout ce qu'il a écrit est déjà dans le fichier.
  child.on('exit', (code) => state.finish(code));

  return child;
}

/** Cadence de relecture du fichier de flux pendant un turn. */
const POLL_MS = 200;

/** Au-delà, `stderr` n'apprend plus rien et encombre le fil. */
const MAX_STDERR = 8000;

/**
 * Suit le fichier de flux d'un turn et en traduit les événements.
 *
 * Un seul chemin de code pour les deux situations qui existent : un turn qu'on vient de
 * lancer, et un turn retrouvé au démarrage après un redémarrage. La différence tient dans
 * deux fonctions — `alive` et `kill` — et dans la position de départ.
 *
 * La position n'avance **que jusqu'à la dernière ligne complète**. C'est ce qui rend la
 * reprise exacte : une ligne coupée par l'arrêt est relue entière au tour suivant, jamais à
 * moitié, et jamais deux fois.
 */
function follow({ convId, provider, handlers, schema, offset, alive, kill, done }) {
  const pendingTools = new Map(); // toolUseId -> item persisté
  let position = offset || 0;
  let fatalReported = false;
  let sawResult = false;
  // Un turn peut rendre un résultat *sans* relevé : c'est ce que fait Claude quand on
  // l'interrompt, et ce qui rendait la consommation d'un turn arrêté définitivement perdue.
  // C'est donc le relevé qui décide s'il faut reconstituer, pas la présence du résultat.
  let sawUsage = false;
  let finished = false;
  let timer = null;

  const outPath = inflight.outPath(convId);
  const errPath = inflight.errPath(convId);

  const ctx = {
    schema: schema || null,
    // Bloc-notes du turn. Sert aux traducteurs qui doivent relier deux événements —
    // chez Codex, la réponse structurée arrive avant le résultat qui la porte.
    state: {},
    session: (id) => handlers.onSession(id),
    // Optionnel : tous les traducteurs n'ont pas de skills à annoncer.
    skills: (found) => handlers.onSkills && handlers.onSkills(found),
    delta: (text, kind) => handlers.onDelta(text, kind || 'text'),
    toolResult: (toolUseId, content, isError) => {
      const item = pendingTools.get(toolUseId);
      if (item) handlers.onToolResult(item, content, isError);
    },
    // Erreur sans espoir de retry : on remonte le message et on coupe court.
    fatal: (text) => {
      if (fatalReported) return;
      fatalReported = true;
      handlers.onItem({ kind: 'result', isError: true, text });
      kill();
    },
  };

  /** Lit ce qui est arrivé depuis la dernière fois, et le traduit. */
  function drain() {
    let size;
    try {
      size = fs.statSync(outPath).size;
    } catch {
      return; // fichier pas encore là, ou déjà nettoyé
    }
    if (size <= position) return;

    const length = size - position;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(outPath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, position);
    } finally {
      fs.closeSync(fd);
    }

    const text = buffer.toString('utf8');
    const lastBreak = text.lastIndexOf('\n');
    if (lastBreak === -1) return; // rien de complet : on réessaiera d'ici

    const complete = text.slice(0, lastBreak + 1);
    position += Buffer.byteLength(complete, 'utf8');

    for (const line of complete.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let evt;
      try {
        evt = JSON.parse(trimmed);
      } catch {
        continue; // ligne non-JSON (bannière, warning) : on ignore
      }
      const items = provider.mapEvent(evt, ctx);
      for (const item of items) {
        if (item.kind === 'result') {
          sawResult = true;
          if (
            (item.modelUsage && Object.keys(item.modelUsage).length) ||
            item.codexUsage ||
            item.costUsd
          ) {
            sawUsage = true;
          }
        }
        const saved = handlers.onItem(item);
        if (item.toolUseId && saved) pendingTools.set(item.toolUseId, saved);
      }
    }

    inflight.advance(convId, position);
  }

  function readStderr() {
    try {
      return fs.readFileSync(errPath, 'utf8').trim().slice(-MAX_STDERR);
    } catch {
      return '';
    }
  }

  /**
   * Conclut le turn. `code` peut être inconnu quand on a repris un turn dont on n'a pas
   * lancé le processus : on tranche alors sur ce que le flux a réellement dit, un événement
   * `result` valant une fin normale.
   */
  function finish(code, message) {
    if (finished) return;
    finished = true;
    if (timer) clearInterval(timer);
    drain(); // dernier passage : le process a pu écrire juste avant de sortir
    // Aucun relevé de consommation dans ce turn : on le reconstitue depuis le flux, avant que
    // `done` n'efface le fichier. Sans ça les tokens d'un turn coupé — redémarrage,
    // interruption — ne seraient comptés nulle part, et le journal semblerait figé.
    if (!sawUsage) {
      const modelUsage = partialUsage(convId, provider);
      if (modelUsage) {
        handlers.onItem({ kind: 'result', isError: false, partial: true, modelUsage });
      }
    }
    const stderr = message || readStderr();
    const resolved = code === null || code === undefined ? (sawResult ? 0 : -1) : code;
    done({ code: resolved, stderr, fatalReported });
  }

  timer = setInterval(() => {
    drain();
    // Le processus est parti : c'est la seule façon de le savoir quand on ne l'a pas lancé,
    // et un filet quand on l'a lancé mais que l'événement de sortie s'est perdu.
    if (!alive()) finish(null);
  }, POLL_MS);
  if (timer.unref) timer.unref();

  // Un premier passage tout de suite : au démarrage, le fichier contient déjà tout ce qui a
  // été écrit pendant que l'application était arrêtée.
  drain();

  return { finish, drain };
}

/**
 * Reprend un turn retrouvé au démarrage.
 *
 * Le CLI a continué d'écrire dans son fichier pendant que l'application était arrêtée — c'est
 * tout l'intérêt de ne plus passer par un tuyau. On relit depuis la position déjà traitée,
 * puis on suit comme si de rien n'était.
 *
 * @param {object} record enregistrement rendu par `inflight.list()`
 * @param {object} conv
 * @param {object} handlers  les mêmes que `runTurn`
 * @returns {{pid: number, finish: Function}}
 */
function resumeTurn(record, conv, handlers) {
  const provider = PROVIDERS[conv.provider];
  if (!provider) throw new Error(`Provider inconnu : ${conv.provider}`);

  const state = follow({
    convId: conv.id,
    provider,
    handlers,
    schema: null, // un turn repris ne redemande pas de sortie structurée : elle est déjà écrite
    offset: record.offset || 0,
    kill: () => killTree(record.pid),
    alive: () => inflight.alive(record.pid),
    done: ({ code, stderr, fatalReported }) => {
      inflight.close(conv.id);
      handlers.onExit(code, stderr, fatalReported);
    },
  });

  return { pid: record.pid, finish: state.finish };
}

/**
 * Descendants d'un process, lus dans /proc.
 *
 * Signaler le groupe ne suffit pas : les CLIs d'agents lancent les commandes de leurs
 * outils dans une session à part — vérifié sur Grok, dont un `sleep` survivait à
 * l'interruption pendant que le CLI mourait. `setsid` change la session, pas la filiation,
 * donc l'arbre des enfants reste parcourable. Il doit l'être *avant* de tuer quoi que ce
 * soit : une fois le parent mort, ses enfants sont rattachés à init et le lien est perdu.
 */
function descendants(pid, seen) {
  const found = seen || new Set();
  const out = [];
  let raw;
  try {
    raw = fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8');
  } catch {
    return out; // pas de /proc, ou process déjà parti
  }
  for (const token of raw.trim().split(/\s+/)) {
    const kid = Number(token);
    if (!kid || found.has(kid)) continue;
    found.add(kid);
    out.push(kid, ...descendants(kid, found));
  }
  return out;
}

function signal(pid, sig) {
  try {
    process.kill(pid, sig);
  } catch {
    /* déjà mort, ou plus à nous */
  }
}

/**
 * Interrompt un turn et tout ce qu'il a lancé.
 *
 * Prend un identifiant de processus, pas un objet enfant : un turn repris au démarrage doit
 * pouvoir être interrompu alors qu'on ne l'a pas lancé et qu'on n'en a donc aucun handle.
 *
 * @param {number|{pid: number}} target
 */
function killTree(target) {
  const pid = typeof target === 'number' ? target : target && target.pid;
  if (!pid) return;

  const kids = descendants(pid);

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    signal(pid, 'SIGTERM');
  }
  // Les descendants qui ont fait sécession de leur groupe, un par un.
  for (const pid2 of kids) signal(pid2, 'SIGTERM');

  // Filet : ce qui n'a pas obéi est tué sèchement, des feuilles vers la racine.
  const finish = setTimeout(() => {
    for (const pid2 of [...kids].reverse()) signal(pid2, 'SIGKILL');
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      signal(pid, 'SIGKILL');
    }
  }, 2000);
  if (finish.unref) finish.unref();
}

/** Le fournisseur sait-il démarrer une session en forkant une session existante ? */
function canFork(provider) {
  return Boolean(PROVIDERS[provider] && PROVIDERS[provider].canFork);
}

/**
 * Binaire d'un fournisseur, tel qu'il sera réellement lancé. La détection des comptes
 * doit interroger exactement le même exécutable que les turns, sinon elle pourrait
 * déclarer un fournisseur connecté alors que le turn appelle un autre binaire.
 */
function binFor(provider) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Provider inconnu : ${provider}`);
  return entry.bin();
}

/**
 * Arguments qui seraient passés au binaire pour ce turn. Exposé pour pouvoir les
 * vérifier sans lancer d'agent : une erreur de construction est autrement silencieuse
 * jusqu'à l'appel réel.
 *
 * @param {{schema?: object, promptPath?: string, schemaPath?: string}} [turn]
 */
function buildArgs(conv, images, turn) {
  const provider = PROVIDERS[conv.provider];
  if (!provider) throw new Error(`Provider inconnu : ${conv.provider}`);
  return provider.args(conv, images, turn || {});
}

/**
 * Traduit un événement brut d'un provider. Exposé pour pouvoir rejouer un flux réel
 * enregistré : c'est le seul moyen de vérifier une traduction sans dépenser un turn.
 *
 * @param {string} provider
 * @param {object} evt  une ligne du flux, déjà désérialisée
 * @param {object} ctx  au minimum `{ schema, state }` ; les rappels ne servent qu'aux
 *   événements qui en déclenchent (session, delta, résultat d'outil, erreur fatale)
 */
function mapEvent(provider, evt, ctx) {
  const entry = PROVIDERS[provider];
  if (!entry) throw new Error(`Provider inconnu : ${provider}`);
  return entry.mapEvent(evt, ctx);
}

module.exports = {
  runTurn,
  resumeTurn,
  killTree,
  canFork,
  buildArgs,
  binFor,
  mapEvent,
  splitToolContent,
  appendAttachedFiles,
  agentPath,
  claudeStreamUsage,
  partialUsage,
  mcpServersFor,
  mcpConfigJson,
  cliTimeoutSeconds,
};
