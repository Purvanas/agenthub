'use strict';

const test = require('node:test');
const assert = require('node:assert');

const selection = require('../lib/model-selection');

const LIVE_GROK = {
  defaultModel: 'grok-4.7',
  checkedAt: '2026-11-03T12:00:00.000Z',
  models: [
    {
      value: '', name: 'Grok 4.7', label: 'Dernier modèle — Grok 4.7',
      efforts: [
        { value: '', label: 'Défaut du modèle' },
        { value: 'high', label: 'Élevé' },
        { value: 'xhigh', label: 'Très élevé' },
      ],
    },
    {
      value: 'grok-4.7-build-fast', name: 'Grok 4.7 Fast', label: 'Grok 4.7 Fast — variante rapide',
      efforts: [{ value: '' }, { value: 'high', label: 'Élevé' }],
    },
    {
      value: 'grok-4.6', label: 'Grok 4.6',
      efforts: [{ value: '' }, { value: 'high', label: 'Élevé' }],
    },
  ],
};

test('le défaut Grok est résolu au lancement et figé pour le turn', () => {
  const active = selection.snapshot(
    { provider: 'grok', model: null, effort: 'xhigh' },
    { liveGrok: LIVE_GROK, startedAt: '2026-11-03T12:01:00.000Z' }
  );
  assert.equal(active.model, null);
  assert.equal(active.resolvedModel, 'grok-4.7');
  assert.equal(active.label, 'Défaut CLI · Grok 4.7');
  assert.equal(active.effortLabel, 'Très élevé');
  assert.equal(active.launchedModel, 'grok-4.7');
  assert.equal(active.source, 'cli-default');
  assert.equal(active.resolvedSource, 'cli-catalog');
});

test('Claude et Codex ne prétendent pas connaître leur défaut effectif', () => {
  for (const provider of ['claude', 'codex']) {
    const next = selection.next({ provider, model: null, effort: null }, { liveGrok: null });
    assert.equal(next.label, selection.UNKNOWN_DEFAULT_LABEL);
    assert.equal(next.resolvedModel, undefined);
    assert.equal(next.effortLabel, 'Réglage du CLI');
  }
});

test('le modèle réellement mesuré prime sur le modèle demandé', () => {
  const active = selection.snapshot(
    { provider: 'claude', model: 'opus', effort: 'high' },
    { liveGrok: null }
  );
  assert.deepEqual(
    selection.lastFromResult({ modelUsage: { 'claude-opus-5': {} } }, active),
    { models: ['claude-opus-5'], source: 'measured' }
  );
  assert.deepEqual(selection.lastFromResult({ codexUsage: {} }, active), {
    models: ['opus'], source: 'requested',
  });
});

test('un relevé mesuré ne régresse pas si un résultat final omet son usage', () => {
  const measured = { models: ['grok-4.7'], source: 'measured' };
  const fallback = { models: ['grok-4.6'], source: 'requested' };
  assert.deepEqual(selection.mergeLast(measured, fallback), measured);
  assert.deepEqual(
    selection.mergeLast(measured, { models: ['grok-4.7-build-fast'], source: 'measured' }),
    { models: ['grok-4.7', 'grok-4.7-build-fast'], source: 'measured' }
  );
});

test('un ancien inflight sans snapshot reste explicitement inconnu', () => {
  const active = selection.restore(
    { startedAt: '2026-11-03T12:00:00.000Z' },
    { provider: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    { liveGrok: null }
  );
  assert.equal(active.source, 'unknown-after-restart');
  assert.equal(active.launchedModel, null);
});

test('un changement de modèle remet à zéro un effort devenu incompatible', () => {
  const changed = selection.patch(
    { provider: 'grok', model: null, effort: 'xhigh' },
    { model: 'grok-4.6' },
    { liveGrok: LIVE_GROK }
  );
  assert.deepEqual(changed.patch, { model: 'grok-4.6', effort: null });

  const invalid = selection.patch(
    { provider: 'grok', model: 'grok-4.6', effort: null },
    { effort: 'xhigh' },
    { liveGrok: LIVE_GROK }
  );
  assert.match(invalid.error, /pas disponible/);
});

test('un modèle personnalisé reste accepté sans être inventé dans le catalogue', () => {
  const custom = selection.patch(
    { provider: 'codex', model: null, effort: null },
    { model: 'gpt-futur-custom', effort: 'ultra' },
    { liveGrok: null }
  );
  assert.deepEqual(custom.patch, { model: 'gpt-futur-custom', effort: 'ultra' });
  const next = selection.next(
    { provider: 'codex', ...custom.patch },
    { liveGrok: null }
  );
  assert.equal(next.label, 'gpt-futur-custom');
});

test('les alias Claude sont nommés comme alias, sans fausse version exacte', () => {
  const payload = selection.enrichModels({ claude: [{ value: 'opus', label: 'ancien libellé' }] }, null);
  assert.equal(payload.claude[0].name, 'Opus (alias)');
  assert.equal(payload.claude[0].resolvedModel, undefined);
});

test('les noms enrichis restent courts et le défaut Grok nomme seulement le modèle résolu', () => {
  const payload = selection.enrichModels(
    { grok: LIVE_GROK.models, codex: [{ value: 'gpt-5.6-sol', label: 'gpt-5.6-sol — long détail' }] },
    LIVE_GROK
  );
  assert.equal(payload.grok[1].name, 'Grok 4.7 Fast');
  assert.equal(payload.codex[0].name, 'gpt-5.6-sol');
  assert.equal(selection.defaults(LIVE_GROK).grok.label, 'Grok 4.7');
  assert.equal(payload.grok[0].efforts[0].label, 'Réglage du CLI');
  assert.equal(
    selection.enrichEfforts({ codex: [{ value: '', label: 'Défaut (faible)' }] }).codex[0].label,
    'Réglage du CLI'
  );
});
