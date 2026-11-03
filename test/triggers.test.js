'use strict';

// Échéances et validation des déclencheurs.
//
// C'est le module où une régression est la plus discrète : personne ne remarque qu'un
// « chaque jour à 7 h » est parti à 8 h après le passage à l'heure d'été, sauf en relisant
// les horodatages des exécutions un mois plus tard.

process.env.TZ = 'Europe/Paris';

const test = require('node:test');
const assert = require('node:assert');

const triggers = require('../lib/triggers');

const PROVIDERS = new Set(['claude', 'codex', 'grok']);

/** Date locale, sans suffixe de fuseau : c'est en heure murale que tout est calculé. */
const local = (s) => new Date(s);

test('fréquence infra-journalière : pas fixe depuis le moment donné', () => {
  const next = triggers.nextRun({ frequency: 'hourly', hour: null }, local('2026-07-31T10:12:00'));
  assert.equal(next.toISOString(), local('2026-07-31T11:12:00').toISOString());

  const six = triggers.nextRun({ frequency: 'every6h', hour: null }, local('2026-07-31T10:00:00'));
  assert.equal(six.getHours(), 16);
});

test("une heure déjà passée dans la journée renvoie au lendemain", () => {
  const next = triggers.nextRun({ frequency: 'daily', hour: 7 }, local('2026-07-31T10:00:00'), {
    first: true,
  });
  assert.equal(next.getDate(), 1);
  assert.equal(next.getMonth(), 7); // août
  assert.equal(next.getHours(), 7);
});

test("une heure encore à venir part le jour même", () => {
  const next = triggers.nextRun({ frequency: 'daily', hour: 7 }, local('2026-07-31T05:00:00'), {
    first: true,
  });
  assert.equal(next.getDate(), 31);
  assert.equal(next.getHours(), 7);
});

test('un hebdomadaire tout juste créé part à la prochaine occurrence, pas dans huit jours', () => {
  const next = triggers.nextRun({ frequency: 'weekly', hour: 7 }, local('2026-07-31T10:00:00'), {
    first: true,
  });
  assert.equal(next.getDate(), 1);
});

test('ensuite un hebdomadaire avance bien de sept jours', () => {
  const next = triggers.nextRun({ frequency: 'weekly', hour: 7 }, local('2026-08-01T07:00:00'));
  assert.equal(next.toISOString(), local('2026-08-08T07:00:00').toISOString());
});

test('les jours choisis fonctionnent comme une alarme hebdomadaire', () => {
  const alarm = { frequency: 'weekdays', hour: 7, weekdays: [2, 4, 6] }; // mar, jeu, sam

  const first = triggers.nextRun(alarm, local('2026-08-03T10:00:00'), { first: true });
  assert.equal(first.toISOString(), local('2026-08-04T07:00:00').toISOString());

  const sameDay = triggers.nextRun(alarm, local('2026-08-04T05:00:00'), { first: true });
  assert.equal(sameDay.toISOString(), local('2026-08-04T07:00:00').toISOString());

  const following = triggers.nextRun(alarm, local('2026-08-04T07:00:00'));
  assert.equal(following.toISOString(), local('2026-08-06T07:00:00').toISOString());
});

test('une alarme du dimanche garde son heure au passage à l’heure d’hiver', () => {
  const next = triggers.nextRun(
    { frequency: 'weekdays', hour: 7, weekdays: [0] },
    local('2026-10-24T07:00:00'),
    { first: true }
  );
  assert.equal(next.getDay(), 0);
  assert.equal(next.getDate(), 25);
  assert.equal(next.getHours(), 7);
});

test("l'heure murale est conservée à travers le passage à l'heure d'hiver", () => {
  // 25 octobre 2026 : la nuit dure 25 heures. Une addition de 24 h en millisecondes
  // ramènerait à 6 h ; `setDate` garde 7 h, qui est ce que l'utilisateur a demandé.
  const next = triggers.nextRun({ frequency: 'daily', hour: 7 }, local('2026-10-24T07:00:00'));
  assert.equal(next.getDate(), 25);
  assert.equal(next.getHours(), 7);
});

test("et à travers le passage à l'heure d'été", () => {
  // 29 mars 2026 : la nuit dure 23 heures.
  const next = triggers.nextRun({ frequency: 'daily', hour: 7 }, local('2026-03-28T07:00:00'));
  assert.equal(next.getDate(), 29);
  assert.equal(next.getHours(), 7);
});

test('une fréquence inconnue est une erreur, pas une échéance improvisée', () => {
  assert.throws(() => triggers.nextRun({ frequency: 'lunaire' }, new Date()), /Fréquence inconnue/);
});

// --- Validation -----------------------------------------------------------

const base = {
  name: 'Veille',
  provider: 'claude',
  cwd: '/srv/projects/demo-app',
  prompt: 'Regarde les logs',
  frequency: 'daily',
  hour: 7,
};

test('un déclencheur complet est accepté et normalisé', () => {
  const { trigger, error } = triggers.validate(base, PROVIDERS);
  assert.equal(error, undefined);
  assert.equal(trigger.hour, 7);
  assert.equal(trigger.enabled, true);
  assert.equal(trigger.killAfterMinutes, null);
  assert.equal(trigger.purgeAfterDays, null);
  assert.equal(trigger.notify, 'inherit');
});

test('les jours de semaine sont obligatoires, dedupliques et ranges de lundi a dimanche', () => {
  const { trigger, error } = triggers.validate(
    { ...base, frequency: 'weekdays', weekdays: ['6', 2, 0, 2] },
    PROVIDERS
  );
  assert.equal(error, undefined);
  assert.deepEqual(trigger.weekdays, [2, 6, 0]);

  assert.match(
    triggers.validate({ ...base, frequency: 'weekdays', weekdays: [] }, PROVIDERS).error,
    /au moins un jour/
  );
  assert.match(
    triggers.validate({ ...base, frequency: 'weekdays', weekdays: [7] }, PROVIDERS).error,
    /invalide/
  );
});

test('les champs obligatoires sont refusés vides', () => {
  for (const [field, message] of [
    ['name', /Nom de déclencheur vide/],
    ['cwd', /Dossier de travail vide/],
    ['prompt', /Consigne vide/],
  ]) {
    const { error } = triggers.validate({ ...base, [field]: '  ' }, PROVIDERS);
    assert.match(error, message);
  }
});

test('un provider hors liste est refusé', () => {
  const { error } = triggers.validate({ ...base, provider: 'mistral' }, PROVIDERS);
  assert.match(error, /Provider inconnu/);
});

test("une heure n'a de sens qu'à partir d'une fréquence d'un jour", () => {
  const { error } = triggers.validate({ ...base, frequency: 'hourly', hour: 7 }, PROVIDERS);
  assert.match(error, /L'heure ne se choisit/);

  // Sans heure explicite, la même fréquence passe.
  const ok = triggers.validate({ ...base, frequency: 'hourly', hour: null }, PROVIDERS);
  assert.equal(ok.error, undefined);
  assert.equal(ok.trigger.hour, null);
});

test('une heure hors de 0-23 est refusée', () => {
  for (const hour of [-1, 24, 7.5]) {
    const { error } = triggers.validate({ ...base, hour }, PROVIDERS);
    assert.match(error, /entre 0 et 23/, `heure ${hour}`);
  }
});

test('les garde-fous numériques sont bornés', () => {
  assert.match(triggers.validate({ ...base, killAfterMinutes: 0 }, PROVIDERS).error, /Durée maximale/);
  assert.match(triggers.validate({ ...base, killAfterMinutes: 1441 }, PROVIDERS).error, /Durée maximale/);
  assert.match(triggers.validate({ ...base, purgeAfterDays: 366 }, PROVIDERS).error, /Délai de purge/);

  const ok = triggers.validate({ ...base, killAfterMinutes: 30, purgeAfterDays: 14 }, PROVIDERS);
  assert.equal(ok.trigger.killAfterMinutes, 30);
  assert.equal(ok.trigger.purgeAfterDays, 14);
});

test('le mode de notification est validé contre la liste connue', () => {
  assert.match(triggers.validate({ ...base, notify: 'sms' }, PROVIDERS).error, /notification inconnu/);
  for (const mode of ['inherit', 'never', 'error', 'always']) {
    assert.equal(triggers.validate({ ...base, notify: mode }, PROVIDERS).trigger.notify, mode);
  }
});

test('acceptsHour distingue les fréquences qui portent une heure', () => {
  assert.equal(triggers.acceptsHour('weekdays'), true);
  assert.equal(triggers.acceptsHour('daily'), true);
  assert.equal(triggers.acceptsHour('weekly'), true);
  assert.equal(triggers.acceptsHour('hourly'), false);
  assert.equal(triggers.acceptsHour('inexistante'), false);
});

// --- Exécution unique ------------------------------------------------------
//
// Le point à ne pas casser : un one-shot part une fois et **jamais plus**. Un réarmement
// accidentel ferait repartir un merge en pleine nuit, tous les jours.

/** Un instant dans le futur, à la minute ronde, comme le formulaire l'envoie. */
function soon(minutes) {
  const at = new Date(Date.now() + minutes * 60_000);
  at.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(
    at.getHours()
  )}:${pad(at.getMinutes())}`;
}

test('une exécution unique retient l’instant choisi', () => {
  const when = soon(90);
  const { trigger, error } = triggers.validate(
    { ...base, frequency: 'once', hour: null, runAt: when },
    PROVIDERS
  );
  assert.equal(error, undefined);
  assert.equal(new Date(trigger.runAt).getTime(), new Date(when).getTime());
  assert.equal(trigger.hour, null, "une heure de la journée n'a pas de sens ici");

  const first = triggers.nextRun(trigger, new Date(), { first: true });
  assert.equal(first.getTime(), new Date(when).getTime());
});

test('après son tour, une exécution unique n’a pas d’échéance suivante', () => {
  const { trigger } = triggers.validate(
    { ...base, frequency: 'once', hour: null, runAt: soon(30) },
    PROVIDERS
  );
  // C'est ce `null` que le planificateur enregistre pour désarmer définitivement.
  assert.equal(triggers.nextRun(trigger, new Date(trigger.runAt)), null);
});

test('une exécution unique sans date est refusée', () => {
  assert.match(
    triggers.validate({ ...base, frequency: 'once', hour: null }, PROVIDERS).error,
    /date et l’heure/i
  );
  assert.match(
    triggers.validate({ ...base, frequency: 'once', hour: null, runAt: 'demain' }, PROVIDERS).error,
    /illisibles/
  );
});

test('une heure de la journée en plus de la date est refusée, et le dit', () => {
  // Les deux ensemble sont contradictoires. Le message doit parler de l instant choisi, pas
  // du « moment de la création » qui ne veut rien dire pour un one-shot.
  const { error } = triggers.validate(
    { ...base, frequency: 'once', hour: 7, runAt: soon(60) },
    PROVIDERS
  );
  assert.match(error, /exécution unique porte sa date/);
});

test('une date déjà passée est refusée plutôt que lancée aussitôt', () => {
  // Sinon le turn partirait au tick suivant, donc maintenant : jamais ce qu'on voulait en
  // tapant une date, et un agent qui démarre par surprise est le pire des cas.
  assert.match(
    triggers.validate({ ...base, frequency: 'once', hour: null, runAt: soon(-60) }, PROVIDERS).error,
    /déjà passée/
  );
});

test('la liste des fréquences distingue l’exécution unique', () => {
  const once = triggers.list().find((f) => f.value === 'once');
  assert.equal(once.once, true);
  assert.equal(once.acceptsHour, false);
  assert.equal(triggers.list().find((f) => f.value === 'daily').once, false);
  assert.equal(triggers.isOnce('once'), true);
  assert.equal(triggers.isOnce('daily'), false);
  assert.equal(triggers.list().find((f) => f.value === 'weekdays').weekdays, true);
  assert.equal(triggers.list().find((f) => f.value === 'weekdays').selectable, true);
  assert.equal(triggers.list().find((f) => f.value === 'every2d').selectable, false);
});

test('le planificateur désarme une exécution unique au lieu de la rejouer', () => {
  const scheduler = require('../lib/scheduler');
  const { trigger } = triggers.validate(
    { ...base, frequency: 'once', hour: null, runAt: soon(5) },
    PROVIDERS
  );
  const armed = { ...trigger, nextRunAt: trigger.runAt };
  assert.equal(scheduler.reschedule(armed, new Date()), null);

  // Et une cadence ordinaire, elle, repart bien.
  const daily = triggers.validate({ ...base, frequency: 'daily', hour: 7 }, PROVIDERS).trigger;
  const next = scheduler.reschedule(
    { ...daily, nextRunAt: local('2026-07-31T07:00:00').toISOString() },
    local('2026-07-31T08:00:00')
  );
  assert.ok(next instanceof Date);
});
