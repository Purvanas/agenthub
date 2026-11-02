'use strict';

// Déclencheurs : fréquences proposées, validation, et calcul d'échéance.
//
// Ce module ne persiste rien et ne lance rien. Il porte les règles temporelles, que se
// partagent le modèle de données (`lib/store.js`) et le planificateur : le premier a
// besoin d'une échéance à l'écriture, le second à chaque exécution.
//
// Tout est calculé en heure locale, pour deux raisons. Les tâches cron de la machine
// travaillent en heure locale, et surtout l'heure affichée doit être celle que
// l'utilisateur a saisie — « chaque jour à 7 h » veut dire 7 h chez lui, y compris après
// un passage à l'heure d'été.

const { MODES: NOTIFY_MODES } = require('./notify');
const hooks = require('./hooks');

/**
 * Les présélections. Une expression cron complète serait plus puissante et
 * nettement moins utilisable ; le besoin est de programmer un agent, pas d'écrire une
 * grammaire.
 *
 * `days` marque les fréquences d'un jour ou plus : ce sont les seules pour lesquelles
 * choisir une heure a un sens. Les autres se calent sur leur moment de création.
 */
const FREQUENCIES = {
  // `once` n'a pas de pas : elle porte un instant, pas une cadence. C'est le cas « ce soir
  // 18 h je serai dans le train, lance le merge sans moi » — un rendez-vous, pas une
  // habitude. Elle ne se réarme jamais.
  once: { label: 'Une seule fois', once: true },
  // Pas une cadence : une attente. Le planificateur ne la voit jamais — un déclencheur sur
  // événement n'a pas d'échéance, et c'est `POST /api/hooks/:jeton` qui le lance.
  webhook: { label: 'Sur événement (webhook)', hook: true },
  hourly: { label: 'Toutes les heures', ms: 3_600_000 },
  every6h: { label: 'Toutes les 6 heures', ms: 21_600_000 },
  weekdays: { label: 'Jours de la semaine', days: 1, weekdays: true },
  // Compatibilite avec les déclencheurs créés avant le sélecteur lun–dim. Ils continuent
  // de tourner, mais le formulaire ne les propose plus.
  daily: { label: 'Chaque jour', days: 1, legacy: true },
  every2d: { label: 'Tous les 2 jours', days: 2, legacy: true },
  weekly: { label: 'Chaque semaine', days: 7, legacy: true },
};

/** Une heure ne peut être choisie qu'à partir d'une fréquence d'un jour. */
function acceptsHour(frequency) {
  const freq = FREQUENCIES[frequency];
  return Boolean(freq && freq.days);
}

/** Cette fréquence attend-elle une date et une heure précises plutôt qu'une cadence ? */
function isOnce(frequency) {
  const freq = FREQUENCIES[frequency];
  return Boolean(freq && freq.once);
}

/** Ce déclencheur attend-il un événement au lieu d'une échéance ? */
function isHook(frequency) {
  const freq = FREQUENCIES[frequency];
  return Boolean(freq && freq.hook);
}

function list() {
  return Object.entries(FREQUENCIES).map(([value, freq]) => ({
    value,
    label: freq.label,
    acceptsHour: Boolean(freq.days),
    once: Boolean(freq.once),
    hook: Boolean(freq.hook),
    weekdays: Boolean(freq.weekdays),
    selectable: !freq.legacy,
  }));
}

/**
 * Prochaine échéance après `after`.
 *
 * Le pas dépend de l'usage. À la création, on cherche la prochaine occurrence de l'heure
 * demandée, donc au plus tard le lendemain — un déclencheur hebdomadaire créé un lundi
 * pour 7 h doit partir dès demain 7 h, pas dans huit jours. Ensuite le pas est celui de
 * la fréquence.
 *
 * `setDate` est utilisé plutôt qu'une addition de millisecondes : il conserve l'heure
 * murale à travers un changement d'heure, ce qu'une addition ne fait pas.
 *
 * @param {{frequency: string, hour: number|null}} trigger
 * @param {Date} after
 * @param {{first?: boolean}} [options]
 * @returns {Date}
 */
function nextRun(trigger, after, options) {
  const freq = FREQUENCIES[trigger.frequency];
  if (!freq) throw new Error(`Fréquence inconnue : ${trigger.frequency}`);

  // Sur événement : aucune échéance, jamais. `null` sort le déclencheur de la boucle du
  // planificateur — il n'y entre pas puis n'en sort pas, il n'y est simplement pas.
  if (freq.hook) return null;

  // Une seule fois : l'échéance est l'instant choisi, et il n'y en a pas d'autre après.
  // `null` est donc une réponse valide — c'est ce que le planificateur enregistre pour
  // désarmer définitivement le déclencheur.
  if (freq.once) {
    if (!(options && options.first)) return null;
    const at = new Date(trigger.runAt);
    if (Number.isNaN(at.getTime())) throw new Error(`Date invalide : ${trigger.runAt}`);
    return at;
  }

  if (!freq.days) return new Date(after.getTime() + freq.ms);

  if (freq.weekdays) {
    const wanted = new Set(trigger.weekdays || []);
    const at = new Date(after);
    at.setHours(trigger.hour || 0, 0, 0, 0);
    // Huit passages couvrent toute semaine et le cas où l'heure du jour courant est passée.
    for (let offset = 0; offset < 8; offset += 1) {
      if (at.getTime() > after.getTime() && wanted.has(at.getDay())) return at;
      at.setDate(at.getDate() + 1);
    }
    throw new Error('Aucun jour de semaine sélectionné');
  }

  const step = options && options.first ? 1 : freq.days;
  const at = new Date(after);
  at.setHours(trigger.hour || 0, 0, 0, 0);
  while (at.getTime() <= after.getTime()) at.setDate(at.getDate() + step);
  return at;
}

const MAX_KILL_MINUTES = 24 * 60;
const MAX_PURGE_DAYS = 365;

/**
 * Valide et normalise ce qui arrive de l'API.
 * @returns {{trigger: object}|{error: string}}
 */
function validate(input, providers) {
  const data = input || {};

  const name = String(data.name || '').trim().slice(0, 60);
  if (!name) return { error: 'Nom de déclencheur vide' };

  if (!providers.has(data.provider)) return { error: 'Provider inconnu' };

  const cwd = String(data.cwd || '').trim();
  if (!cwd) return { error: 'Dossier de travail vide' };

  const prompt = String(data.prompt || '').trim();
  if (!prompt) return { error: 'Consigne vide' };

  if (!FREQUENCIES[data.frequency]) return { error: `Fréquence inconnue : ${data.frequency}` };

  // Une seule fois : on attend un instant précis, pas une heure de la journée.
  let runAt = null;
  if (isOnce(data.frequency)) {
    const raw = String(data.runAt || '').trim();
    if (!raw) return { error: 'Choisis la date et l’heure de l’exécution.' };
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return { error: `Date et heure illisibles : ${raw}` };
    // Une échéance passée partirait au tick suivant, donc maintenant : ce n'est jamais ce
    // qu'on voulait en tapant une date, et un agent qui démarre par surprise est le genre
    // de surprise qu'on préfère éviter.
    if (at.getTime() <= Date.now()) {
      return { error: 'Cette date est déjà passée : choisis un moment à venir.' };
    }
    runAt = at.toISOString();
  }

  let hour = null;
  if (data.hour !== undefined && data.hour !== null && data.hour !== '') {
    if (!acceptsHour(data.frequency)) {
      return {
        error: isOnce(data.frequency)
          ? "Une exécution unique porte sa date et son heure : il n'y a pas d'heure de la journée à choisir en plus."
          : isHook(data.frequency)
            ? "Un déclencheur sur événement n'a pas d'heure : c'est l'appel du webhook qui le lance."
            : "L'heure ne se choisit qu'à partir d'une fréquence d'un jour : « " +
              `${FREQUENCIES[data.frequency].label} » se cale sur son moment de création.`,
      };
    }
    hour = Number(data.hour);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      return { error: 'Heure attendue entre 0 et 23' };
    }
  } else if (acceptsHour(data.frequency)) {
    hour = 0;
  }

  let weekdays = null;
  if (FREQUENCIES[data.frequency].weekdays) {
    if (!Array.isArray(data.weekdays)) return { error: 'Choisis au moins un jour de la semaine' };
    const parsed = data.weekdays.map(Number);
    if (parsed.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      return { error: 'Jour de semaine invalide' };
    }
    weekdays = [...new Set(parsed)].sort((a, b) => (a + 6) % 7 - ((b + 6) % 7));
    if (!weekdays.length) return { error: 'Choisis au moins un jour de la semaine' };
  }

  // Délai plancher entre deux événements. Un webhook n'a pas de cadence, donc pas de
  // garde-fou naturel : un dépôt qui pousse quinze fois en deux minutes lancerait quinze
  // agents sur le même dossier de travail. `0` est accepté et veut dire « aucun plancher »,
  // ce qui n'est pas la même chose qu'absent — d'où le passage par `hooks.minIntervalSec`.
  let hookMinIntervalSec = null;
  if (isHook(data.frequency)) {
    if (data.hookMinIntervalSec === undefined || data.hookMinIntervalSec === null || data.hookMinIntervalSec === '') {
      hookMinIntervalSec = hooks.DEFAULT_MIN_INTERVAL_SEC;
    } else {
      const n = Number(data.hookMinIntervalSec);
      if (!Number.isInteger(n) || n < 0 || n > hooks.MAX_MIN_INTERVAL_SEC) {
        return {
          error: `Délai minimum entre deux événements attendu entre 0 et ${hooks.MAX_MIN_INTERVAL_SEC} secondes`,
        };
      }
      hookMinIntervalSec = n;
    }
  }

  const killAfterMinutes = optionalPositive(data.killAfterMinutes, MAX_KILL_MINUTES);
  if (killAfterMinutes === undefined) {
    return { error: `Durée maximale attendue entre 1 et ${MAX_KILL_MINUTES} minutes` };
  }

  const purgeAfterDays = optionalPositive(data.purgeAfterDays, MAX_PURGE_DAYS);
  if (purgeAfterDays === undefined) {
    return { error: `Délai de purge attendu entre 1 et ${MAX_PURGE_DAYS} jours` };
  }

  // Notification de fin d'exécution. `inherit` suit config/notify.json : c'est le défaut,
  // pour qu'un réglage global n'ait pas à être répété sur chaque déclencheur.
  const notify = String(data.notify || 'inherit');
  if (!NOTIFY_MODES.includes(notify)) {
    return { error: `Mode de notification inconnu : ${notify}` };
  }

  // Rapport de fin : un second turn dans la même conversation, qui rédige ce que
  // `reportSpec` décrit. `reportEmail` vide veut dire « rapport oui, mail non » : il reste
  // lisible dans le fil et dans l'historique.
  const report = Boolean(data.report);
  const reportSpec = String(data.reportSpec || '').trim().slice(0, 2000);
  const reportEmail = String(data.reportEmail || '').trim().slice(0, 200);
  if (reportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportEmail)) {
    return { error: `Adresse de destination invalide : ${reportEmail}` };
  }
  if (reportEmail && !report) {
    return { error: "Une adresse est renseignée mais le rapport n'est pas demandé." };
  }

  return {
    trigger: {
      name,
      provider: data.provider,
      model: data.model ? String(data.model) : null,
      effort: data.effort ? String(data.effort) : null,
      cwd,
      prompt,
      frequency: data.frequency,
      hour,
      weekdays,
      runAt,
      hookMinIntervalSec,
      // Le jeton est engendré à la création et **jamais réécrit** par une modification : le
      // changer casserait silencieusement l'URL déjà recopiée dans le service tiers.
      // `server.js` le pose sur un déclencheur qui n'en a pas encore.
      hookToken: isHook(data.frequency) ? String(data.hookToken || '') || null : null,
      killAfterMinutes,
      purgeAfterDays,
      notify,
      report,
      reportSpec: report ? reportSpec : '',
      reportEmail: report ? reportEmail : '',
      enabled: data.enabled === undefined ? true : Boolean(data.enabled),
    },
  };
}

/** @returns {number|null|undefined} null si absent, undefined si invalide. */
function optionalPositive(value, max) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) return undefined;
  return n;
}

module.exports = { FREQUENCIES, acceptsHour, isOnce, isHook, list, nextRun, validate };
