'use strict';

// Mode objectif : on donne un but, l'agent ne s'arrête qu'une fois qu'il est atteint.
//
// Un turn s'arrête quand le modèle décide qu'il a fini de parler, ce qui n'est pas la même
// chose que d'avoir fini le travail. « Continue » tapé à la main dix fois de suite, c'est
// exactement ce que ce mode remplace.
//
// La boucle est faite de deux turns par tour :
//
//   1. le travail — le premier tour porte l'objectif, les suivants disent ce qui reste ;
//   2. la **vérification**, dans la même conversation, à sortie structurée : est-ce atteint,
//      et sinon qu'est-ce qui manque.
//
// Pourquoi séparer la vérification du travail. Demander « et dis-moi si tu as fini » dans le
// même turn laisse le modèle juge et partie au moment où il est le plus pressé de conclure ;
// il répond oui. Un turn dédié, dont la seule sortie possible est `{done, remaining}`, l'oblige
// à regarder l'objectif et son propre travail avant de trancher. C'est le même raisonnement que
// le rapport de fin de déclencheur, et pour la même raison : ce qu'on veut savoir n'existe pas
// encore quand le travail commence.
//
// Le prix à payer est un turn de plus par tour. Il est petit — la vérification ne relance rien,
// elle relit — et il achète la seule chose qui rende la boucle sûre : une condition d'arrêt qui
// ne dépend pas de l'humeur du modèle.
//
// Et une boucle doit être bornée. Sans plafond, un objectif mal posé — « rends le site
// parfait » — tourne jusqu'à épuisement du quota, la nuit, sans personne pour regarder.

/** Ce que la vérification doit rendre, et rien d'autre. */
const SCHEMA = {
  type: 'object',
  properties: {
    done: {
      type: 'boolean',
      description:
        "true seulement si l'objectif est entièrement atteint et vérifié. En cas de doute, " +
        'false : une relance de plus coûte moins cher qu’un objectif déclaré atteint à tort.',
    },
    remaining: {
      type: 'string',
      description:
        "Ce qui reste à faire, en une à trois phrases, exploitable comme consigne. Vide si " +
        "l'objectif est atteint.",
    },
    summary: {
      type: 'string',
      description: 'Où en est le travail, en une phrase.',
    },
  },
  required: ['done', 'remaining', 'summary'],
  additionalProperties: false,
};

/** Plafonds proposés, et celui qu'on prend sans rien demander. */
const ROUND_CHOICES = [3, 6, 12, 25];
const DEFAULT_ROUNDS = 6;

/**
 * État d'un objectif qui démarre.
 *
 * `round` compte les tours de **travail** déjà lancés, celui en cours compris : il vaut donc 1
 * dès le départ, et c'est ce qui s'affiche.
 */
function start(text, rounds) {
  const max = ROUND_CHOICES.includes(Number(rounds)) ? Number(rounds) : DEFAULT_ROUNDS;
  return {
    text: String(text || '').trim().slice(0, 4000),
    round: 1,
    max,
    startedAt: new Date().toISOString(),
  };
}

/**
 * Premier message : l'objectif, et les règles de la boucle.
 *
 * Ce qui est écrit ici vient de ce que fait un agent laissé libre sur un objectif : il rend la
 * main pour demander si la direction est la bonne (personne ne répondra), ou il annonce ce
 * qu'il *va* faire au lieu de le faire. La vérification qui suit est annoncée, délibérément :
 * un modèle qui sait qu'on va contrôler son travail le finit.
 */
function buildFirstPrompt(objective) {
  return [
    'Objectif à atteindre :',
    String(objective || '').trim(),
    '',
    'Travaille jusqu’à ce qu’il soit atteint. Ne demande pas de validation intermédiaire et ' +
      'ne rends pas la main pour proposer un plan : personne ne répondra avant que ce soit fait.',
    '',
    'À la fin de ce turn, on te demandera si l’objectif est atteint et ce qui manque encore. ' +
      'Tant qu’il reste quelque chose, tu seras relancé avec la liste de ce qui reste.',
  ].join('\n');
}

/**
 * Turn de vérification. Il interdit de travailler : sans ça l'agent profite du turn pour
 * finir ce qu'il a laissé, et la vérification coûte autant que le travail — en plus de ne
 * plus rien vérifier.
 */
function buildCheckPrompt(objective) {
  return [
    'Arrête-toi et fais le point, sans rien modifier.',
    '',
    "L'objectif était :",
    String(objective || '').trim(),
    '',
    "Est-il entièrement atteint ? Tu peux relire des fichiers ou relancer une vérification " +
      'de lecture seule (tests, build, lint) pour en juger, mais ne modifie rien et ' +
      "n'entreprends aucun nouveau travail : c'est le tour suivant qui s'en chargera.",
    '',
    "Si quelque chose manque, dis exactement quoi : ta réponse servira telle quelle de " +
      'consigne au tour suivant.',
  ].join('\n');
}

/** Relance : ce qui reste, et rien d'autre — l'objectif est rappelé pour le cadre. */
function buildContinuePrompt(goal, check) {
  return [
    `Objectif non atteint (tour ${goal.round} sur ${goal.max} au plus).`,
    '',
    'Objectif :',
    String(goal.text || '').trim(),
    '',
    'Ce qui reste, d’après le point que tu viens de faire :',
    String((check && check.remaining) || '').trim(),
    '',
    'Reprends le travail là-dessus. Ne redemande pas de validation.',
  ].join('\n');
}

/**
 * Valide ce que la vérification a rendu. Le schéma garantit les champs, pas leur cohérence :
 * un `done: false` sans rien dans `remaining` ne relancerait rien d'exploitable.
 *
 * @returns {{done: boolean, remaining: string, summary: string}|null}
 */
function normalize(structured) {
  if (!structured || typeof structured !== 'object') return null;
  if (typeof structured.done !== 'boolean') return null;
  const remaining = String(structured.remaining || '').trim();
  const summary = String(structured.summary || '').trim();
  // Non atteint mais rien à dire de ce qui manque : la relance n'aurait aucune consigne.
  if (!structured.done && !remaining) return null;
  return { done: structured.done, remaining, summary };
}

/**
 * La décision de la boucle, hors de tout : ni turn, ni store, ni websocket.
 *
 * C'est le seul endroit où l'on décide de dépenser un turn de plus. Le sortir du serveur permet
 * de le prouver — une boucle qui ne s'arrête pas ne se voit pas en la relisant, elle se voit en
 * la faisant tourner.
 *
 * @param {{text: string, round: number, max: number}|null} goal
 * @param {'done'|'error'|'stopped'} outcome issue du turn qui vient de finir
 * @param {{done: boolean, remaining: string}|null} [check] point rendu par la vérification ;
 *   `undefined` tant qu'elle n'a pas eu lieu
 * @returns {{action: 'check'|'continue'|'reached'|'exhausted'|'abandon', reason?: string,
 *   round?: number}|null} null quand il n'y a pas d'objectif : rien ne change au turn ordinaire
 */
function decide(goal, outcome, check) {
  if (!goal || !goal.text) return null;

  // Un turn interrompu à la main est une décision de l'utilisateur : la boucle s'arrête là.
  if (outcome === 'stopped') return { action: 'abandon', reason: 'interrompu' };
  // Et une boucle ne s'acharne pas sur un agent qui échoue : sans ça, une erreur
  // d'authentification consommerait les relances une par une, sans jamais avancer.
  if (outcome === 'error') return { action: 'abandon', reason: 'échec du turn' };

  // Le travail est fait, reste à savoir si l'objectif l'est.
  if (check === undefined) return { action: 'check' };

  // Vérification inexploitable : on préfère rendre la main plutôt que relancer à l'aveugle.
  if (!check) return { action: 'abandon', reason: 'vérification illisible' };

  if (check.done) return { action: 'reached' };
  if (goal.round >= goal.max) return { action: 'exhausted' };
  return { action: 'continue', round: goal.round + 1 };
}

module.exports = {
  SCHEMA,
  ROUND_CHOICES,
  DEFAULT_ROUNDS,
  start,
  buildFirstPrompt,
  buildCheckPrompt,
  buildContinuePrompt,
  normalize,
  decide,
};
