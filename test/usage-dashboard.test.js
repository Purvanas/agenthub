'use strict';

// Tableau de bord de consommation : où part l'argent, plutôt que combien il en part.
//
// Le journal ne porte qu'un identifiant de conversation. Tout l'enjeu est là : rattacher une
// ligne à un projet sans que le module ne connaisse le magasin de conversations, et ne pas
// perdre le coût d'une conversation supprimée.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dashboard-'));
process.env.AGENTHUB_DATA = DATA;

const usage = require('../lib/usage');

/** Une ligne de journal, réduite à ce que le tableau de bord lit. */
function line(ts, convId, provider, costUsd, tokens = 1000) {
  return {
    ts,
    provider,
    convId,
    model: 'm',
    inputTokens: tokens,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    costUsd,
  };
}

function ledger(rows) {
  fs.writeFileSync(usage.LEDGER, rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
}

/** Résolution comme le serveur la fournit : le projet, le titre, le fournisseur. */
const RESOLVE = {
  'c-hub': { project: '.', title: 'refonte', provider: 'claude' },
  'c-hub-2': { project: '.', title: 'quotas', provider: 'codex' },
  'c-site': { project: '/tmp/site', title: 'landing', provider: 'grok' },
};
const resolve = (id) => RESOLVE[id] || null;

test.beforeEach(() => ledger([]));

test('le cout se regroupe par projet, worktrees replies', () => {
  ledger([
    line('2026-08-03T10:00:00.000Z', 'c-hub', 'claude', 1),
    line('2026-08-04T10:00:00.000Z', 'c-hub-2', 'codex', 2),
    line('2026-08-05T10:00:00.000Z', 'c-site', 'grok', 0.5),
  ]);
  const { projects } = usage.dashboard({ resolve });
  assert.deepEqual(
    projects.map((p) => [p.project, p.costUsd, p.convs]),
    [
      ['.', 3, 2],
      ['/tmp/site', 0.5, 1],
    ]
  );
});

// Le champ écrit sur la ligne prime : c'est lui qui rattache une conversation supprimée à son
// projet, et c'est le cas majoritaire — 122 des 125 conversations du journal réel.
test('le projet ecrit sur la ligne prime sur le magasin', () => {
  ledger([
    { ...line('2026-08-03T10:00:00.000Z', 'effacee', 'claude', 7), project: '/tmp/site' },
    // Le magasin ne connaît `c-hub` que par `resolve` : la ligne n'a pas de projet, donc on
    // remonte à la conversation. C'est le comportement des lignes écrites avant le champ.
    line('2026-08-03T11:00:00.000Z', 'c-hub', 'claude', 1),
  ]);
  assert.deepEqual(
    usage.dashboard({ resolve }).projects.map((p) => [p.project, p.costUsd]),
    [
      ['/tmp/site', 7],
      ['.', 1],
    ]
  );
});

// Le point qui décide de la fonctionnalité : le journal survit à la conversation. Écarter ces
// lignes ferait un tableau dont la somme des projets ne fait pas le total.
test('une conversation supprimee garde son cout, sans projet', () => {
  ledger([
    line('2026-08-03T10:00:00.000Z', 'c-hub', 'claude', 1),
    line('2026-08-03T11:00:00.000Z', 'disparue', 'claude', 4),
  ]);
  const { projects, top } = usage.dashboard({ resolve });
  const orphan = projects.find((p) => p.project === '');
  assert.equal(orphan.costUsd, 4);
  assert.equal(
    projects.reduce((sum, p) => sum + p.costUsd, 0),
    5
  );
  const row = top.find((t) => t.convId === 'disparue');
  assert.equal(row.missing, true);
  assert.equal(row.title, null);
  assert.equal(usage.dashboard({ resolve }).top.find((t) => t.convId === 'c-hub').missing, false);
});

test('le classement va du plus cher au moins cher, borne', () => {
  ledger([
    line('2026-08-03T10:00:00.000Z', 'c-hub', 'claude', 1),
    line('2026-08-03T11:00:00.000Z', 'c-hub', 'claude', 1),
    line('2026-08-04T10:00:00.000Z', 'c-site', 'grok', 5),
    line('2026-08-04T11:00:00.000Z', 'c-hub-2', 'codex', 3),
  ]);
  const { top } = usage.dashboard({ resolve, top: 2 });
  assert.deepEqual(
    top.map((t) => [t.convId, t.costUsd, t.turns]),
    [
      ['c-site', 5, 1],
      ['c-hub-2', 3, 1],
    ]
  );
});

test('les turns d une meme conversation s additionnent, et la derniere date gagne', () => {
  ledger([
    line('2026-08-03T10:00:00.000Z', 'c-hub', 'claude', 1),
    line('2026-08-09T22:00:00.000Z', 'c-hub', 'claude', 2),
    line('2026-08-05T10:00:00.000Z', 'c-hub', 'claude', 0.5),
  ]);
  const row = usage.dashboard({ resolve }).top[0];
  assert.equal(row.costUsd, 3.5);
  assert.equal(row.turns, 3);
  assert.equal(row.lastAt, '2026-08-09T22:00:00.000Z');
});

// Le lundi est calculé en heure locale, comme le planificateur : un turn du dimanche soir
// appartient à la semaine qu'on vient de vivre. Les dates sont donc construites en local.
test('la semaine commence le lundi, en heure locale', () => {
  assert.equal(usage.weekStart(new Date(2026, 7, 12, 12, 0)), '2026-08-10'); // mercredi
  assert.equal(usage.weekStart(new Date(2026, 7, 10, 0, 30)), '2026-08-10'); // lundi tôt
  assert.equal(usage.weekStart(new Date(2026, 7, 16, 23, 30)), '2026-08-10'); // dimanche tard
  assert.equal(usage.weekStart(new Date(2026, 7, 17, 0, 30)), '2026-08-17'); // lundi suivant
});

test('les semaines sortent dans l ordre du temps, avec le detail par fournisseur', () => {
  ledger([
    line(new Date(2026, 7, 12, 12).toISOString(), 'c-hub', 'claude', 1),
    line(new Date(2026, 7, 13, 12).toISOString(), 'c-hub-2', 'codex', 2),
    line(new Date(2026, 7, 18, 12).toISOString(), 'c-site', 'grok', 4),
  ]);
  const { weeks } = usage.dashboard({ resolve });
  assert.deepEqual(
    weeks.map((w) => [w.week, w.costUsd]),
    [
      ['2026-08-10', 3],
      ['2026-08-17', 4],
    ]
  );
  assert.deepEqual(weeks[0].providers, { claude: 1, codex: 2 });
});

test('seules les dernieres semaines demandees sont rendues', () => {
  ledger([
    line(new Date(2026, 6, 6, 12).toISOString(), 'c-hub', 'claude', 1),
    line(new Date(2026, 6, 13, 12).toISOString(), 'c-hub', 'claude', 1),
    line(new Date(2026, 6, 20, 12).toISOString(), 'c-hub', 'claude', 1),
  ]);
  assert.deepEqual(
    usage.dashboard({ resolve, weeks: 2 }).weeks.map((w) => w.week),
    ['2026-07-13', '2026-07-20']
  );
});

test('un mois choisi borne tout le tableau', () => {
  ledger([
    line('2026-07-15T10:00:00.000Z', 'c-hub', 'claude', 9),
    line('2026-08-15T10:00:00.000Z', 'c-site', 'grok', 1),
  ]);
  const board = usage.dashboard({ month: '2026-08', resolve });
  assert.deepEqual(
    board.projects.map((p) => p.project),
    ['/tmp/site']
  );
  assert.equal(board.top.length, 1);
});

test('sans resolveur, tout est inconnu mais rien n est perdu', () => {
  ledger([line('2026-08-03T10:00:00.000Z', 'c-hub', 'claude', 2)]);
  const board = usage.dashboard({});
  assert.equal(board.projects[0].project, '');
  assert.equal(board.projects[0].costUsd, 2);
});
