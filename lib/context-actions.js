'use strict';

// Actions de contexte : compactage CLI et reprise légère via note de passation.
//
// Le contexte utile vit dans la session du fournisseur, pas dans le journal UI.
// Compacter = demander au CLI (`/compact`). Reprendre léger = nouvelle conversation
// avec une note, **sans** `--fork-session` (un fork recopierait le contexte saturé).

const handoff = require('./handoff');

const COMPACTABLE = new Set(['claude', 'grok']);

const DEFAULT_RESUME_PROMPT = [
  'Reprends le travail à partir de la note de passation.',
  'Ne repose pas les questions déjà tranchées ; enchaîne sur ce qui reste à faire.',
].join(' ');

const DEFAULT_KEEP =
  'garde l’objectif en cours, les décisions prises, les fichiers touchés et l’état des tâches';

function supportsCompact(provider) {
  return COMPACTABLE.has(provider);
}

/**
 * Prompt envoyé tel quel au CLI. Slash command documentée chez Claude et Grok.
 * @param {{ keep?: string }} [opts]
 */
function compactPrompt(opts = {}) {
  const keep = typeof opts.keep === 'string' ? opts.keep.trim() : '';
  return keep ? `/compact ${keep}` : '/compact';
}

function preferSynthetic({ status, running, forceSynthetic } = {}) {
  if (forceSynthetic) return true;
  if (running) return true;
  if (status === 'error') return true;
  return false;
}

function clip(text, max = 280) {
  const s = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function formatTokens(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return String(Math.round(n));
}

/**
 * Note de secours quand l'agent parent ne peut plus écrire (session morte, turn en
 * cours, statut error). Assez structurée pour coller à `handoff.REQUEST`.
 */
function syntheticNote(conv = {}) {
  const items = Array.isArray(conv.items) ? conv.items : [];
  const users = items
    .filter((i) => i && i.kind === 'user' && i.text && String(i.text).trim())
    .map((i) => clip(i.text, 220));
  const texts = items
    .filter((i) => i && i.kind === 'text' && i.text && String(i.text).trim())
    .map((i) => clip(i.text, 220));
  const lastError = [...items]
    .reverse()
    .find((i) => i && i.kind === 'result' && i.isError);

  const lastUsers = users.slice(-8);
  const lastTexts = texts.slice(-4);
  const goal =
    (conv.goal && (conv.goal.text || conv.goal.title || conv.goal)) || null;

  const lines = [
    '## Objectif',
    goal ? String(goal).trim() : conv.title || 'Reprendre le travail en cours',
    '',
    '## Décisions prises',
    lastUsers.length
      ? lastUsers.map((t) => `- Demande utilisateur : ${t}`).join('\n')
      : '- (aucun message utilisateur exploitable dans le fil)',
    '',
    '## Ce qui reste à faire',
    '- Lire cette note, puis enchaîner sur la dernière demande non terminée.',
    lastUsers.length ? `- Dernière demande : ${lastUsers[lastUsers.length - 1]}` : null,
    '',
    '## Pièges',
    lastError
      ? `- La conversation d'origine s'est terminée en erreur : ${clip(lastError.text || 'Échec du turn', 200)}`
      : '- Contexte probablement saturé : éviter de relire de grosses images en rafale.',
    conv.contextTokens != null
      ? `- Contexte mesuré : ${formatTokens(conv.contextTokens)}` +
        (conv.contextWindow ? ` / ${formatTokens(conv.contextWindow)}` : '') +
        ' tokens.'
      : null,
    `- Provider : ${conv.provider || '?'}${conv.model ? ` · modèle ${conv.model}` : ''}`,
    conv.cwd ? `- cwd : ${conv.cwd}` : null,
    conv.status ? `- statut parent : ${conv.status}` : null,
    '',
    '## Fichiers touchés',
    '- Voir le dépôt / le cwd ci-dessus ; la note synthétique ne liste pas les diffs.',
    '',
    '## Extraits récents (agent)',
    lastTexts.length ? lastTexts.map((t) => `- ${t}`).join('\n') : '- (aucun)',
  ].filter((line) => line != null);

  return `${lines.join('\n').trim()}\n`;
}

function lightResumePrompt(instruction, noteFile) {
  const text = (instruction && String(instruction).trim()) || DEFAULT_RESUME_PROMPT;
  return handoff.childPrompt(text, noteFile);
}

module.exports = {
  COMPACTABLE,
  DEFAULT_RESUME_PROMPT,
  DEFAULT_KEEP,
  supportsCompact,
  compactPrompt,
  preferSynthetic,
  syntheticNote,
  lightResumePrompt,
};
