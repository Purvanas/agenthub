'use strict';

// Rapport de fin d'exécution.
//
// Ce que ces tests protègent : le schéma garantit la *forme* de ce que l'agent renvoie,
// jamais le fond. Un rapport vide passe la validation du CLI, et il ne faut pas qu'un mail
// vide en sorte.

const test = require('node:test');
const assert = require('node:assert');

const report = require('../lib/report');

test('la consigne libre est reprise mot pour mot', () => {
  const prompt = report.buildPrompt('Liste les dépendances obsolètes.');
  assert.ok(prompt.includes('Liste les dépendances obsolètes.'));
});

test('sans consigne, le rapport a quand même un objet', () => {
  const prompt = report.buildPrompt('');
  assert.ok(prompt.includes(report.DEFAULT_SPEC));
});

test('le prompt interdit de retravailler et de renvoyer à la conversation', () => {
  // Sans ces deux garde-fous : un agent relance des commandes « pour vérifier » et le
  // rapport coûte autant que le travail ; ou il écrit « comme dit plus haut » dans un mail
  // qui partira seul.
  const prompt = report.buildPrompt('peu importe');
  assert.ok(/n'entreprends aucun nouveau travail/i.test(prompt), prompt);
  assert.ok(/lu seul/i.test(prompt), prompt);
});

test('un rapport complet est normalisé', () => {
  const written = report.normalize({
    subject: '  3 dépendances obsolètes  ',
    status: 'attention',
    body: '## Constat\nTrois paquets en retard.',
  });
  assert.equal(written.subject, '3 dépendances obsolètes');
  assert.equal(written.status, 'attention');
  assert.ok(written.body.startsWith('## Constat'));
});

test('un corps vide ne fait pas un rapport', () => {
  assert.equal(report.normalize({ subject: 'Rien', status: 'ok', body: '   ' }), null);
  assert.equal(report.normalize({ subject: 'Rien', status: 'ok' }), null);
  assert.equal(report.normalize(null), null);
  assert.equal(report.normalize('une chaîne'), null);
});

test('une issue inconnue retombe sur ok plutôt que de casser le rendu', () => {
  assert.equal(report.normalize({ subject: 'x', status: 'catastrophe', body: 'y' }).status, 'ok');
});

test('un sujet absent ne laisse pas un mail sans objet', () => {
  assert.equal(report.normalize({ status: 'ok', body: 'y' }).subject, 'Rapport');
});

test('le mail porte le nom du déclencheur, le contexte et le lien', () => {
  const mail = report.buildMail({
    report: { subject: 'Tout va bien', status: 'ok', body: 'Rien à signaler.' },
    triggerName: 'Veille deps',
    conv: {
      id: 'abc',
      provider: 'claude',
      model: 'sonnet',
      cwd: '/tmp/x',
      totalCostUsd: 0.1234,
    },
    appUrl: 'http://exemple/',
  });

  assert.equal(mail.subject, '[Veille deps] Tout va bien');
  assert.ok(mail.text.startsWith('Rien à signaler.'));
  assert.ok(mail.text.includes('rien à signaler · claude · sonnet · /tmp/x'), mail.text);
  assert.ok(mail.text.includes('0.1234 $'));
  // Une seule barre oblique : l'URL de base peut en porter une, l'ancre aussi.
  assert.ok(mail.text.includes('http://exemple/#abc'), mail.text);
});

test('sans nom de déclencheur, le sujet reste celui du rapport', () => {
  const mail = report.buildMail({
    report: { subject: 'Fait', status: 'ok', body: 'ok' },
    conv: { id: 'a', provider: 'codex' },
  });
  assert.equal(mail.subject, 'Fait');
});
