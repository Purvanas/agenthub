'use strict';

// Journal de consommation : ce qui est compté, et d'où vient le chiffre.
//
// Le point qui compte : Claude chiffre lui-même ses turns, les autres passent par la table
// de prix, et un modèle absent de la table ne doit pas faire disparaître les tokens.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-usage-'));
process.env.AGENTHUB_DATA = DATA;

const usage = require('../lib/usage');

test('le modèle facturé privilégie le relevé du provider', () => {
  assert.deepEqual(
    usage.billedModels(
      'claude',
      { modelUsage: { 'claude-opus-5': {}, 'claude-haiku-4-5': {} } },
      'opus'
    ),
    ['claude-opus-5', 'claude-haiku-4-5']
  );
});

test('Codex expose son modèle imposé, ou son vrai défaut connu', () => {
  assert.deepEqual(usage.billedModels('codex', { codexUsage: {} }, 'gpt-5.6-terra'), [
    'gpt-5.6-terra',
  ]);
  assert.deepEqual(usage.billedModels('codex', { codexUsage: {} }, null), ['gpt-5.6-sol']);
});

test('un turn Claude est enregistré par modèle, au coût donné par le provider', () => {
  const rows = usage.record({
    provider: 'claude',
    convId: 'conv-1',
    triggerId: null,
    item: {
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 1000,
          outputTokens: 500,
          cacheCreationInputTokens: 20000,
          cacheReadInputTokens: 4000,
          costUSD: 0.42,
        },
        'claude-haiku-4-5': { inputTokens: 100, outputTokens: 50, costUSD: 0.01 },
      },
    },
  });
  assert.equal(rows.length, 2);

  const summary = usage.summary('all');
  assert.equal(summary.totals.turns, 2);
  assert.equal(summary.totals.costUsd, 0.43);
  assert.equal(summary.totals.tokens, 1000 + 500 + 20000 + 4000 + 100 + 50);

  const claude = summary.providers.find((p) => p.provider === 'claude');
  assert.equal(claude.models.length, 2);
  assert.equal(claude.models[0].model, 'claude-opus-5', 'trié par tokens décroissants');
  assert.equal(claude.models[0].costSource, 'provider');
});

test("l'entrée annoncée par Codex inclut son cache : on ne compte le cache qu'une fois", () => {
  usage.record({
    provider: 'codex',
    convId: 'conv-2',
    fallbackModel: 'gpt-5.6-sol',
    item: { codexUsage: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 100 } },
  });

  const codex = usage.summary('all').providers.find((p) => p.provider === 'codex');
  // 800 annoncés dont 100 relus du cache : 700 tokens ont réellement été envoyés neufs.
  // Les additionner donnerait 1100 tokens pour 900 consommés.
  assert.equal(codex.inputTokens, 700);
  assert.equal(codex.tokens, 1000);
  assert.equal(codex.models[0].costSource, 'table');
  // gpt-5.6-sol : 5 $ l'entrée, 0,50 $ le cache relu, 30 $ la sortie, par million. Facturer
  // les 100 tokens de cache aux deux tarifs à la fois coûterait 0,0005 $ de plus — dix fois
  // plus sur une longue session, où 90 % de l'entrée annoncée vient du cache.
  const expected = (700 / 1e6) * 5 + (100 / 1e6) * 0.5 + (200 / 1e6) * 30;
  assert.ok(Math.abs(codex.costUsd - expected) < 1e-9, `${codex.costUsd} attendu ${expected}`);
});

test('un turn sans modèle imposé est chiffré au modèle par défaut du provider', () => {
  usage.record({
    provider: 'codex',
    convId: 'conv-2b',
    item: { codexUsage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0 } },
  });

  const row = usage
    .summary('all')
    .providers.find((p) => p.provider === 'codex')
    .models.find((m) => m.model === 'défaut');
  assert.equal(row.costSource, 'table', 'sans repli, « défaut » comptait pour zéro');
  assert.ok(Math.abs(row.costUsd - 5) < 1e-9, `${row.costUsd} attendu 5 (gpt-5.6-sol)`);
});

test("un modèle absent de la table garde ses tokens et n'invente pas de coût", () => {
  usage.record({
    provider: 'codex',
    convId: 'conv-2c',
    fallbackModel: 'gpt-inexistant-9',
    item: { codexUsage: { inputTokens: 700, outputTokens: 300 } },
  });

  const row = usage
    .summary('all')
    .providers.find((p) => p.provider === 'codex')
    .models.find((m) => m.model === 'gpt-inexistant-9');
  assert.equal(row.tokens, 1000);
  assert.equal(row.costUsd, 0);
  assert.equal(row.costSource, 'inconnu');
});

test('le coût par déclencheur compte les exécutions, pas les lignes', () => {
  // Deux turns de la même exécution, dont un passé par deux modèles : trois lignes, une
  // seule exécution. Compter les lignes fausserait la moyenne.
  const item = {
    modelUsage: {
      'claude-opus-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.1 },
      'claude-haiku-4-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.05 },
    },
  };
  usage.record({ provider: 'claude', convId: 'run-1', triggerId: 'tr-1', item });
  usage.record({
    provider: 'claude',
    convId: 'run-1',
    triggerId: 'tr-1',
    item: { modelUsage: { 'claude-opus-5': { inputTokens: 10, outputTokens: 5, costUSD: 0.05 } } },
  });

  const agg = usage.byTrigger()['tr-1'];
  assert.equal(agg.turns, 3);
  assert.equal(agg.runs, 1);
  assert.ok(Math.abs(agg.costUsd - 0.2) < 1e-9);
  assert.ok(Math.abs(agg.avgCostUsd - 0.2) < 1e-9);
});

test('les lignes sans déclencheur ne sont rattachées à aucun', () => {
  const perTrigger = usage.byTrigger();
  assert.equal(Object.keys(perTrigger).length, 1);
  assert.equal(perTrigger['tr-1'].runs, 1);
});

test('le filtre par mois ne garde que le mois demandé', () => {
  const all = usage.summary('all');
  assert.equal(all.months.length, 1);

  const month = all.months[0];
  assert.equal(usage.summary(month).totals.turns, all.totals.turns);
  assert.equal(usage.summary('1999-01').totals.turns, 0);
});

test('une ligne corrompue est ignorée sans perdre le journal', () => {
  fs.appendFileSync(path.join(DATA, 'usage.jsonl'), 'ceci n\'est pas du JSON\n');
  assert.ok(usage.summary('all').totals.turns > 0);
});

test('un turn sans consommation n\'écrit aucune ligne', () => {
  const before = usage.summary('all').totals.turns;
  assert.equal(usage.record({ provider: 'grok', convId: 'c', item: { costUsd: 0 } }).length, 0);
  assert.equal(usage.summary('all').totals.turns, before);
});

// --- Turns coupés avant leur relevé final ---------------------------------
//
// Ce qu'un turn tué par un redémarrage a consommé n'était journalisé nulle part : Claude ne
// chiffre son turn qu'à la fin. La consommation semblait donc figée sur une matinée passée à
// redémarrer agentHub. Le relevé est maintenant reconstitué depuis le flux, et chiffré ici.

test('un turn coupé est chiffré depuis la table, au centime près', () => {
  // Relevé exact d'un turn réel du 03/08/2026, que Claude Code avait lui-même chiffré
  // 2,9627 $. C'est la vérification de la table de prix : si elle dérive, ce test le dit.
  const rows = usage.record({
    provider: 'claude',
    convId: 'conv-coupe',
    item: {
      partial: true,
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 50,
          outputTokens: 25452,
          cacheCreationInputTokens: 115596,
          cacheCreation1hInputTokens: 115596,
          cacheReadInputTokens: 2340379,
        },
      },
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].costSource, 'table');
  assert.equal(rows[0].partial, true);
  assert.ok(
    Math.abs(rows[0].costUsd - 2.9627) < 1e-4,
    `${rows[0].costUsd} attendu 2,9627 — le chiffre de Claude Code pour ce turn`
  );
});

test("l'écriture de cache est plus chère que l'entrée, et pire pour une heure", () => {
  const written = (over) =>
    usage.record({
      provider: 'claude',
      convId: `conv-cache-${over.cacheCreation1hInputTokens ? '1h' : '5m'}`,
      item: {
        partial: true,
        modelUsage: { 'claude-haiku-4-5': { cacheCreationInputTokens: 1e6, ...over } },
      },
    })[0].costUsd;

  // Haiku 4.5 : 1 $ l'entrée, donc 1,25 $ l'écriture courte et 2 $ l'écriture d'une heure.
  // Compter ce million au tarif d'entrée — ce que faisait la table — sous-estimait de moitié.
  assert.ok(Math.abs(written({}) - 1.25) < 1e-9);
  assert.ok(Math.abs(written({ cacheCreation1hInputTokens: 1e6 }) - 2) < 1e-9);
});

test("un modèle dont un seul turn est estimé n'est plus annoncé comme chiffré par le provider", () => {
  const turn = (item) => usage.record({ provider: 'grok', convId: 'conv-melange', item });
  const measured = { 'grok-4.5-build': { inputTokens: 10, outputTokens: 5 } };

  turn({ modelUsage: { 'grok-4.5-build': { ...measured['grok-4.5-build'], costUSD: 0.01 } } });
  turn({ partial: true, modelUsage: measured });

  const model = usage
    .summary('all')
    .providers.find((p) => p.provider === 'grok')
    .models.find((m) => m.model === 'grok-4.5-build');
  assert.equal(model.costSource, 'table', 'la première ligne ne doit pas décider pour les autres');
});

// --- Codex annonce un cumul, pas une consommation -------------------------

test('de deux turns Codex, seule la progression du cumul est comptée', () => {
  const turn = (inputTokens, outputTokens, cacheReadTokens) =>
    usage.record({
      provider: 'codex',
      convId: 'conv-cumul',
      fallbackModel: 'gpt-5.6-sol',
      item: { codexUsage: { inputTokens, outputTokens, cacheReadTokens } },
    });

  turn(900000, 6000, 780000);
  const second = turn(1030000, 6800, 900000);

  // Progression du cumul : 130 000 d'entrée, dont 120 000 relus du cache. Restent 10 000
  // tokens réellement neufs. La ligne d'avant valait 1 030 000 : elle comptait toute la
  // session, cache compris, à chaque turn.
  assert.equal(second[0].inputTokens, 10000, 'ni le passé, ni le cache, comptés deux fois');
  assert.equal(second[0].outputTokens, 800);
  assert.equal(second[0].cacheReadTokens, 120000);
  assert.deepEqual(second[0].codexTotals, {
    inputTokens: 1030000,
    outputTokens: 6800,
    cacheReadTokens: 900000,
  });

  assert.equal(turn(1030000, 6800, 900000).length, 0, 'un cumul inchangé n’écrit aucune ligne');
});

test('un cumul en baisse est une session neuve, pas un delta négatif', () => {
  const turn = (inputTokens, cacheReadTokens) =>
    usage.record({
      provider: 'codex',
      convId: 'conv-reforkee',
      fallbackModel: 'gpt-5.6-sol',
      item: { codexUsage: { inputTokens, outputTokens: 100, cacheReadTokens } },
    });

  turn(500000, 400000);
  const fresh = turn(12000, 8000);
  assert.equal(fresh[0].inputTokens, 4000, 'son cumul est le sien : 12 000 annoncés, 8 000 en cache');
  assert.equal(fresh[0].cacheReadTokens, 8000);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
