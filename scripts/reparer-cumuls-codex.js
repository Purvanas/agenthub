#!/usr/bin/env node
'use strict';

// Réparation ponctuelle du journal de consommation : les lignes Codex écrites avant le
// 03/08/2026 comptent deux fois, et de deux façons qui se cumulent.
//
// 1. Elles portent le **cumul de session** annoncé par le CLI, pas ce que le turn a consommé :
//    chaque turn recomptait tout le contexte des précédents.
// 2. L'entrée annoncée **inclut** le cache relu, qui était donc facturé aux deux tarifs à la
//    fois — et compté deux fois dans les tokens. Sur une longue session, où 90 % de l'entrée
//    vient du cache, c'est le terme dominant.
//
// Voir `docs/solutions/la-consommation-comptait-des-cumuls-et-perdait-des-turns.md`.
//
// Deux propriétés en font un outil sûr plutôt qu'un coup de force sur `data/` :
//
// 1. **Idempotent.** Le cumul de départ est lu dans `codexTotals` quand la ligne le porte,
//    sinon dans ses propres champs — c'est exactement ce qu'ils contenaient à l'époque. Une
//    ligne déjà convertie redonne donc le même delta, et relancer ne dérive pas.
// 2. **Sûr face aux écritures concurrentes.** Le journal est append-only et l'application
//    tourne pendant la réparation : ce qui est ajouté entre la lecture et l'écriture est
//    recopié à la fin avant le remplacement, qui est atomique.
//
// Usage : `node scripts/reparer-cumuls-codex.js [--appliquer]`
// Sans `--appliquer`, rien n'est écrit : le script montre ce qu'il ferait.

const fs = require('fs');
const path = require('path');

const usage = require('../lib/usage');

const APPLY = process.argv.includes('--appliquer');
const LEDGER = usage.LEDGER;

function money(value) {
  return `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;
}

const raw = fs.readFileSync(LEDGER, 'utf8');
const lines = raw.split('\n');

const lastTotals = new Map(); // convId -> dernier cumul annoncé
let repaired = 0;
let costBefore = 0;
let costAfter = 0;
let tokensBefore = 0;
let tokensAfter = 0;

const out = lines.map((line) => {
  const trimmed = line.trim();
  if (!trimmed) return line;

  let row;
  try {
    row = JSON.parse(trimmed);
  } catch {
    return line; // ligne illisible : on la garde telle quelle plutôt que de la perdre
  }
  if (row.provider !== 'codex') return line;

  // Ce que le CLI avait annoncé. Les lignes d'avant la correction le portent dans leurs
  // propres champs ; celles d'après, dans `codexTotals`.
  const totals = row.codexTotals || {
    inputTokens: row.inputTokens || 0,
    outputTokens: row.outputTokens || 0,
    cacheReadTokens: row.cacheReadTokens || 0,
  };
  const delta = usage.codexTokens(lastTotals.get(row.convId), totals);
  lastTotals.set(row.convId, totals);

  const fixed = { ...row, ...delta, codexTotals: totals };
  const computed = usage.priceFromTable('codex', fixed.model, fixed);
  fixed.costUsd = computed || 0;
  fixed.costSource = computed == null ? 'inconnu' : 'table';

  const sum = (r) =>
    (r.inputTokens || 0) + (r.outputTokens || 0) + (r.cacheCreateTokens || 0) + (r.cacheReadTokens || 0);
  tokensBefore += sum(row);
  tokensAfter += sum(fixed);
  costBefore += row.costUsd || 0;
  costAfter += fixed.costUsd || 0;
  if (JSON.stringify(fixed) !== JSON.stringify(row)) repaired += 1;

  return JSON.stringify(fixed);
});

console.log(`journal      : ${LEDGER}`);
console.log(`lignes Codex : ${lastTotals.size} conversations, ${repaired} lignes à corriger`);
console.log(`tokens       : ${tokensBefore.toLocaleString('fr-FR')} → ${tokensAfter.toLocaleString('fr-FR')}`);
console.log(`coût Codex   : ${money(costBefore)} → ${money(costAfter)} (${money(costAfter - costBefore)})`);

if (!repaired) {
  console.log('\nRien à faire : le journal est déjà en deltas.');
  process.exit(0);
}

if (!APPLY) {
  console.log('\nEssai à blanc. Relancer avec --appliquer pour écrire.');
  process.exit(0);
}

// Sauvegarde d'abord, horodatée : `data/` est hors du dépôt, personne d'autre ne la fera.
const backup = `${LEDGER}.avant-deltas-${new Date().toISOString().replace(/[:.]/g, '-')}`;
fs.copyFileSync(LEDGER, backup);

// Ce qui a été ajouté pendant qu'on travaillait — un turn qui vient de finir — est recopié
// tel quel à la fin. Le journal ne fait que grossir : ce qu'on avait lu en est un préfixe,
// et tout ce qui suit est neuf.
const now = fs.readFileSync(LEDGER, 'utf8');
const appended = now.startsWith(raw) ? now.slice(raw.length) : '';
if (!now.startsWith(raw)) {
  console.error('\nLe journal a été réécrit sous nos pieds : on ne touche à rien.');
  process.exit(1);
}
if (appended) console.log(`\n${appended.trim().split('\n').length} ligne(s) ajoutée(s) pendant la réparation, conservée(s).`);

const tmp = `${LEDGER}.tmp`;
fs.writeFileSync(tmp, out.join('\n') + appended);
fs.renameSync(tmp, LEDGER);

console.log(`\nÉcrit. Sauvegarde : ${path.basename(backup)}`);
