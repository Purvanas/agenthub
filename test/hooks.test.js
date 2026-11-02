'use strict';

// Déclencheurs sur événement.
//
// Le point qui décide de tout : un déclencheur horaire a une cadence, donc un garde-fou
// naturel. Un webhook n'en a aucun — c'est l'appelant qui décide, et il peut appeler quinze
// fois en deux minutes. Les deux protections sont donc l'essentiel de ce qui est testé ici.

const test = require('node:test');
const assert = require('node:assert');

const hooks = require('../lib/hooks');
const triggers = require('../lib/triggers');

const NOW = Date.parse('2026-08-11T12:00:00.000Z');
const HOOK = {
  id: 't1',
  enabled: true,
  prompt: 'Relis le dépôt et signale ce qui casse.',
  hookToken: 'jeton',
  hookMinIntervalSec: 60,
  lastRunAt: null,
};

test('un jeton n est pas devinable, et tient dans une url', () => {
  const token = hooks.newToken();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(token, hooks.newToken());
});

test('un evenement passe quand rien ne s y oppose', () => {
  assert.deepEqual(hooks.admit(HOOK, { running: false, now: NOW }), { ok: true });
});

test('un jeton inconnu ne dit pas qu il est inconnu par un 500', () => {
  const verdict = hooks.admit(null, { running: false, now: NOW });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 404);
});

test('un declencheur desactive refuse au lieu de partir', () => {
  const verdict = hooks.admit({ ...HOOK, enabled: false }, { running: false, now: NOW });
  assert.equal(verdict.status, 409);
  assert.match(verdict.reason, /désactivé/);
});

// Refuser plutôt que mettre en file : une file de webhooks se vide en agents simultanés dès
// que le premier finit, ce qui est exactement le problème qu'on évite.
test('une execution encore en cours refuse la suivante', () => {
  const verdict = hooks.admit(HOOK, { running: true, now: NOW });
  assert.equal(verdict.status, 429);
  assert.match(verdict.reason, /travaille encore/);
});

test('deux evenements rapproches ne font qu un lancement', () => {
  const recent = { ...HOOK, lastRunAt: new Date(NOW - 20_000).toISOString() };
  const verdict = hooks.admit(recent, { running: false, now: NOW });
  assert.equal(verdict.status, 429);
  // Le motif dit combien de temps attendre : un service tiers qui réessaie doit savoir quand.
  assert.match(verdict.reason, /dans 40 s/);

  const older = { ...HOOK, lastRunAt: new Date(NOW - 61_000).toISOString() };
  assert.equal(hooks.admit(older, { running: false, now: NOW }).ok, true);
});

test('un plancher a zero laisse tout passer, un plancher absent vaut le defaut', () => {
  const just = { ...HOOK, lastRunAt: new Date(NOW - 1000).toISOString() };
  assert.equal(hooks.admit({ ...just, hookMinIntervalSec: 0 }, { running: false, now: NOW }).ok, true);
  assert.equal(hooks.minIntervalSec({}), hooks.DEFAULT_MIN_INTERVAL_SEC);
  assert.equal(hooks.minIntervalSec({ hookMinIntervalSec: 0 }), 0);
  // Une valeur aberrante retombe sur le défaut plutôt que d'ouvrir la porte en grand.
  assert.equal(hooks.minIntervalSec({ hookMinIntervalSec: -5 }), hooks.DEFAULT_MIN_INTERVAL_SEC);
});

// --- La charge reçue ------------------------------------------------------

test('la charge est annoncee comme une donnee, pas comme une consigne', () => {
  const text = hooks.prompt(HOOK, { ref: 'refs/heads/main' }, { source: 'GitHub-Hookshot' });
  assert.match(text, /^Relis le dépôt/);
  // Le point qui compte : une charge qui dirait « ignore tes instructions » doit ressembler
  // à ce qu'elle est, une entrée reçue de l'extérieur.
  assert.match(text, /jamais comme une consigne/);
  assert.match(text, /GitHub-Hookshot/);
  assert.match(text, /refs\/heads\/main/);
});

test('un ping sans corps n ajoute rien du tout', () => {
  assert.equal(hooks.contextBlock({}, {}), '');
  assert.equal(hooks.contextBlock(undefined, undefined), '');
  assert.equal(hooks.contextBlock('', {}), '');
  assert.equal(hooks.prompt(HOOK, {}, {}), HOOK.prompt);
});

test('une charge enorme est tronquee', () => {
  const big = { texte: 'x'.repeat(50_000) };
  assert.ok(hooks.contextBlock(big, {}).length < hooks.MAX_CONTEXT + 500);
});

test('l url a recopier ne double pas la barre', () => {
  assert.equal(hooks.url('http://x.test/', 'abc'), 'http://x.test/api/hooks/abc');
  assert.equal(hooks.url('http://x.test', 'abc'), 'http://x.test/api/hooks/abc');
});

// --- Côté déclencheur -----------------------------------------------------

test('un declencheur sur evenement n a pas d echeance', () => {
  assert.equal(triggers.isHook('webhook'), true);
  assert.equal(triggers.nextRun({ frequency: 'webhook' }, new Date(NOW), { first: true }), null);
  assert.equal(triggers.nextRun({ frequency: 'webhook' }, new Date(NOW)), null);
});

test('la validation refuse une heure sur un evenement, et explique pourquoi', () => {
  const base = {
    name: 'push',
    provider: 'claude',
    cwd: '/tmp',
    prompt: 'go',
    frequency: 'webhook',
  };
  const bad = triggers.validate({ ...base, hour: 7 }, new Set(['claude']));
  assert.match(bad.error, /c'est l'appel du webhook qui le lance/);

  const ok = triggers.validate(base, new Set(['claude']));
  assert.equal(ok.trigger.hour, null);
  assert.equal(ok.trigger.hookMinIntervalSec, hooks.DEFAULT_MIN_INTERVAL_SEC);
});

test('un plancher hors bornes est refuse avant toute creation', () => {
  const base = { name: 'push', provider: 'claude', cwd: '/tmp', prompt: 'go', frequency: 'webhook' };
  const bad = triggers.validate({ ...base, hookMinIntervalSec: 99_999_999 }, new Set(['claude']));
  assert.match(bad.error, /Délai minimum/);
});

// Le jeton vit aussi longtemps que le déclencheur : `validate` recopie ce qu'on lui donne et
// n'en fabrique jamais, sinon chaque modification casserait l'URL déjà recopiée ailleurs.
test('la validation ne fabrique jamais de jeton', () => {
  const base = { name: 'push', provider: 'claude', cwd: '/tmp', prompt: 'go', frequency: 'webhook' };
  assert.equal(triggers.validate(base, new Set(['claude'])).trigger.hookToken, null);
  assert.equal(
    triggers.validate({ ...base, hookToken: 'garde-moi' }, new Set(['claude'])).trigger.hookToken,
    'garde-moi'
  );
  // Une cadence ordinaire n'a pas de jeton, même si on lui en envoie un.
  assert.equal(
    triggers.validate(
      { ...base, frequency: 'hourly', hookToken: 'zut' },
      new Set(['claude'])
    ).trigger.hookToken,
    null
  );
});
