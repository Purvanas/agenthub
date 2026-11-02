'use strict';

// Rapport de fin d'exécution d'un déclencheur.
//
// Un déclencheur part à 3 h du matin et travaille seul. La notification de fin dit qu'il a
// réussi ; elle ne dit pas *ce qu'il a fait*. Le rapport comble ça : une fois le travail
// terminé, on redemande à l'agent — dans **la même conversation**, donc avec tout son
// contexte — de rédiger ce que l'utilisateur a décrit à la création du déclencheur.
//
// Le deuxième turn est délibéré. Demander le rapport dans la consigne initiale serait moins
// cher mais moins fiable : l'agent le rédigerait avant de savoir comment son travail se
// termine, et un rapport écrit d'avance ne vaut rien.
//
// La réponse est contrainte par un schéma JSON, ce que les trois CLIs savent faire (voir la
// section « Sortie structurée » du README). Sans ça il faudrait deviner où s'arrête le
// sujet et où commence le corps.

/**
 * Schéma volontairement maigre. Le *contenu* est dicté par la consigne libre de
 * l'utilisateur ; imposer des champs ici reviendrait à lui reprendre ce qu'on vient de lui
 * donner. Ne sont fixés que les deux choses dont l'application a besoin pour elle-même :
 * un sujet pour le mail, et une issue pour colorer une ligne d'historique.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    subject: {
      type: 'string',
      description: "Sujet du rapport, en une ligne, sans préfixe ni date. Ex. « 3 dépendances obsolètes, aucune faille »",
    },
    status: {
      type: 'string',
      enum: ['ok', 'attention', 'echec'],
      description:
        "État de ce que le travail a révélé, et non de son exécution : 'ok' si rien ne demande d'action, 'attention' s'il y a quelque chose à regarder, 'echec' si le travail n'a pas pu être mené.",
    },
    body: {
      type: 'string',
      description: 'Le rapport lui-même, en markdown, suivant exactement la consigne donnée.',
    },
  },
  required: ['subject', 'status', 'body'],
  additionalProperties: false,
};

/** Consigne par défaut, quand le déclencheur en demande un sans préciser quoi. */
const DEFAULT_SPEC =
  'Résume ce que tu viens de faire : ce que tu as trouvé, ce que tu as modifié, et ce ' +
  "qui reste à faire ou mérite l'attention.";

/**
 * Prompt du turn de rapport.
 *
 * Deux précisions gagnées à l'usage. D'abord interdire de retravailler : sans ça un agent
 * relance des commandes « pour vérifier » et le rapport coûte autant que le travail.
 * Ensuite dire que personne ne lira la conversation : sinon le rapport renvoie à « ce que
 * j'ai décrit plus haut », alors qu'il partira seul dans un mail.
 */
function buildPrompt(spec) {
  return [
    'Ton travail est terminé. Rédige maintenant son rapport.',
    '',
    'Ce que le rapport doit contenir :',
    (spec || DEFAULT_SPEC).trim(),
    '',
    "N'entreprends aucun nouveau travail : ne modifie rien, ne relance pas de commandes " +
      'pour vérifier. Appuie-toi sur ce que tu as déjà fait dans cette conversation.',
    '',
    'Le rapport sera lu seul, sans cette conversation à côté : ne renvoie pas à ce qui a ' +
      'été dit plus haut, et écris-le de façon autonome.',
  ].join('\n');
}

/** Étiquettes lisibles des issues, partagées par le fil, l'historique et le mail. */
const STATUS_LABELS = {
  ok: 'rien à signaler',
  attention: 'à regarder',
  echec: 'échec',
};

/**
 * Valide et normalise ce que l'agent a renvoyé.
 *
 * Le CLI garantit la forme, pas le fond : une chaîne vide passe le schéma. Un rapport sans
 * corps ne vaut pas la peine d'être envoyé, et vaut mieux qu'un mail vide.
 *
 * @returns {{subject: string, status: string, body: string}|null}
 */
function normalize(structured) {
  if (!structured || typeof structured !== 'object') return null;
  const body = String(structured.body || '').trim();
  if (!body) return null;
  const status = STATUS_LABELS[structured.status] ? structured.status : 'ok';
  return {
    subject: String(structured.subject || '').trim().slice(0, 160) || 'Rapport',
    status,
    body,
  };
}

/**
 * Mail à envoyer. Le sujet porte le nom du déclencheur : dans une boîte, « Rapport » seul
 * ne dit pas de qui il vient, et plusieurs déclencheurs écrivent au même endroit.
 *
 * Le corps est envoyé en texte brut, markdown compris. Convertir en HTML demanderait un
 * moteur de rendu, et le markdown se lit très bien tel quel — c'est même pour ça qu'il
 * existe.
 */
function buildMail({ report, triggerName, conv, appUrl }) {
  const subject = `${triggerName ? `[${triggerName}] ` : ''}${report.subject}`;

  const lines = [report.body, ''];
  lines.push('—');
  const meta = [conv.provider, conv.model, conv.cwd].filter(Boolean).join(' · ');
  lines.push(`${STATUS_LABELS[report.status]} · ${meta}`);
  if (conv.totalCostUsd) lines.push(`Coût de l'exécution : ${conv.totalCostUsd.toFixed(4)} $`);
  if (appUrl) lines.push(`${String(appUrl).replace(/\/$/, '')}/#${conv.id}`);

  return { subject: subject.slice(0, 200), text: lines.join('\n') };
}

module.exports = { SCHEMA, DEFAULT_SPEC, STATUS_LABELS, buildPrompt, normalize, buildMail };
