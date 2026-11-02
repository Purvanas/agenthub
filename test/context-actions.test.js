'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ctx-'));
process.env.AGENTHUB_DATA = DATA;

const ctx = require('../lib/context-actions');
const handoff = require('../lib/handoff');

test('seul Claude et Grok savent compacter via slash', () => {
  assert.equal(ctx.supportsCompact('claude'), true);
  assert.equal(ctx.supportsCompact('grok'), true);
  assert.equal(ctx.supportsCompact('codex'), false);
  assert.equal(ctx.supportsCompact('inconnu'), false);
});

test('le prompt de compactage est /compact, avec consigne optionnelle', () => {
  assert.equal(ctx.compactPrompt(), '/compact');
  assert.equal(ctx.compactPrompt({ keep: '  garde auth et tests  ' }), '/compact garde auth et tests');
  assert.equal(ctx.compactPrompt({ keep: '' }), '/compact');
});

test('une note synthétique reprend titre, objectif et derniers messages utiles', () => {
  const note = ctx.syntheticNote({
    title: 'Galerie interne',
    goal: { text: 'Peupler les galeries' },
    cwd: '/tmp/projet',
    provider: 'grok',
    model: 'grok-4.5',
    contextTokens: 1_382_188,
    contextWindow: 500_000,
    status: 'error',
    items: [
      { kind: 'user', text: 'Ajoute Alice Martin' },
      { kind: 'text', text: 'Fiche créée, 101 images.' },
      { kind: 'user', text: 'Ajoute : Bob Dupont' },
      { kind: 'thinking', text: 'ignoré' },
      { kind: 'tool', tool: 'Bash' },
      {
        kind: 'text',
        text: 'Ingest en cours… ' + 'x'.repeat(800),
      },
      { kind: 'result', isError: true, text: 'Échec du turn' },
    ],
  });

  assert.match(note, /## Objectif/);
  assert.match(note, /Peupler les galeries/);
  assert.match(note, /## Décisions prises/);
  assert.match(note, /## Ce qui reste à faire/);
  assert.match(note, /Bob Dupont/);
  assert.match(note, /Alice Martin/);
  assert.match(note, /Échec du turn/);
  assert.match(note, /1[\s]?382[\s]?188|1382188/);
  assert.match(note, /\/tmp\/projet/);
  // Pas de dump monstrueux : les longs textes sont tronqués.
  assert.ok(note.length < 4000);
  assert.ok(!note.includes('x'.repeat(800)));
});

test('on préfère la note agent sauf si le parent est inutilisable', () => {
  assert.equal(ctx.preferSynthetic({ status: 'idle', running: false }), false);
  assert.equal(ctx.preferSynthetic({ status: 'working', running: true }), true);
  assert.equal(ctx.preferSynthetic({ status: 'error', running: false }), true);
  assert.equal(ctx.preferSynthetic({ status: 'done', running: false }), false);
  assert.equal(ctx.preferSynthetic({ status: 'idle', running: false, forceSynthetic: true }), true);
});

test('la consigne enfant pointe la note et demande de reprendre', () => {
  const file = handoff.write('parent-test', '## Objectif\nTester.');
  const prompt = ctx.lightResumePrompt('Continue le travail en cours.', file);
  assert.match(prompt, /Continue le travail en cours/);
  assert.match(prompt, /Note de passation/);
  assert.ok(prompt.includes(file));
});

test('DEFAULT_RESUME_PROMPT est non vide', () => {
  assert.ok(ctx.DEFAULT_RESUME_PROMPT.trim().length > 10);
});
