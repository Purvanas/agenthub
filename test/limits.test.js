'use strict';

// Parsing des quotas d'abonnement.
//
// Aucune API n'expose ces chiffres : on lit du texte destiné à des humains, chez Claude
// comme chez Codex. Une reformulation de leur CLI casse le parsing en silence — ces tests
// figent les formats observés le 31/07/2026, pour qu'un changement se voie ici et non par
// une sidebar qui affiche « Quotas indisponibles » sans qu'on sache depuis quand.

const test = require('node:test');
const assert = require('node:assert');

const {
  parseClaude,
  parseCodex,
  parseResetAt,
  updatePrompt,
  dismissUpdate,
} = require('../lib/limits');

const CLAUDE_OUTPUT = `
Current session: 29% used · resets Jul 31, 12:59pm (UTC)
Current week (all models): 8% used · resets Aug 4, 9:00am (UTC)
Current week (Opus): 12.5% used · resets Aug 4, 9:00am (UTC)
`;

test('les trois compteurs de Claude sont lus et traduits', () => {
  const buckets = parseClaude(CLAUDE_OUTPUT);
  assert.equal(buckets.length, 3);

  assert.equal(buckets[0].label, 'Fenêtre de 5 h');
  assert.equal(buckets[0].percent, 29);
  assert.equal(buckets[0].resets, 'Jul 31, 12:59pm (UTC)');
  assert.equal(buckets[1].label, 'Semaine · tous modèles');
  assert.equal(buckets[2].percent, 12.5);
});

test('un compteur sans heure de réinitialisation reste lisible', () => {
  const [bucket] = parseClaude('Current session: 4% used');
  assert.equal(bucket.percent, 4);
  assert.equal(bucket.resets, null);
});

test("un texte que Claude aurait reformulé ne produit aucun chiffre inventé", () => {
  assert.deepEqual(parseClaude('Usage this session is around a third of your limit.'), []);
});

const CODEX_OUTPUT = `
│ Account: dev@example.test (ChatGPT Plus)
│ 5h limit:      [██░░░░░░] 72% left (resets 14:01 on 31 Jul)
│ Weekly limit:  [░░░░░░░░] 0% left (resets 07:01 on 5 Aug)
`;

test('Codex donne du restant, on stocke du consommé', () => {
  const { buckets, account } = parseCodex(CODEX_OUTPUT);
  assert.equal(buckets.length, 2);

  assert.equal(buckets[0].percent, 28); // 72 % restant
  assert.equal(buckets[0].resets, '14:01 on 31 Jul');

  assert.equal(buckets[1].label, 'Semaine');
  assert.equal(buckets[1].percent, 100); // quota épuisé
  assert.equal(account, 'dev@example.test (ChatGPT Plus)');
});

test('un écran Codex sans limites ne renvoie rien plutôt que zéro', () => {
  const { buckets, account } = parseCodex('│ Account: dev@example.test\n│ Loading…');
  assert.deepEqual(buckets, []);
  assert.equal(account, 'dev@example.test');
});

// Quand une version de Codex sort, son TUI s'arrête sur un menu avant de démarrer et
// le relevé des quotas expire sans que personne ne voie pourquoi. On le passe tout
// seul — mais l'entrée présélectionnée lance `npm install -g`, donc ces tests portent
// autant sur ce qu'on ne doit PAS valider que sur le passage lui-même.
const MENU = [
  '  ✨ Update available! 0.146.0 -> 0.146.1',
  '',
  '  Release notes: https://github.com/openai/codex/releases/latest',
  '',
  '  1. Update now (runs `npm install -g @openai/codex`)',
  '  2. Skip',
  '  3. Skip until next version',
  '',
  '  Press enter to continue',
];

// Un tmux de papier : il rend le menu, déplace son curseur, et note les touches.
function fakeTmux(options = {}) {
  const lines = options.lines || MENU;
  const state = { selected: options.selected === undefined ? 1 : options.selected, keys: [] };

  state.screen = () =>
    lines.map((l) => l.replace(/^ {2}(\d+)\./, (m, n) => (Number(n) === state.selected ? `› ${n}.` : m))).join('\n');

  state.t = async (...args) => {
    if (args[0] === 'capture-pane') return { stdout: state.screen(), stderr: '', err: null };
    if (args[0] === 'send-keys') {
      const key = args[args.length - 1];
      state.keys.push(key);
      if (key === 'Down') state.selected = Math.min(3, state.selected + 1);
      if (key === 'Up') state.selected = Math.max(1, state.selected - 1);
      if (key === 'Enter') state.validated = state.selected;
    }
    return { stdout: '', stderr: '', err: null };
  };
  return state;
}

test('l’écran de mise à jour est reconnu, curseur compris', () => {
  const seen = updatePrompt(fakeTmux().screen());
  assert.deepEqual(seen, { selected: 1, skip: 2, update: 1 });
});

test('le curseur descend sur « Skip » avant qu’on valide', async () => {
  const tmux = fakeTmux();
  assert.equal(await dismissUpdate(tmux.t, 's', updatePrompt(tmux.screen())), true);

  assert.deepEqual(tmux.keys, ['Down', 'Enter']);
  assert.equal(tmux.validated, 2); // « Skip », jamais « Update now »
});

test('un curseur déjà plus bas remonte au lieu de dépasser', async () => {
  const tmux = fakeTmux({ selected: 3 });
  assert.equal(await dismissUpdate(tmux.t, 's', updatePrompt(tmux.screen())), true);

  assert.deepEqual(tmux.keys, ['Up', 'Enter']);
  assert.equal(tmux.validated, 2);
});

test('un menu reformulé n’est pas reconnu, donc pas validé à l’aveugle', async () => {
  const reformule = MENU.map((l) => l.replace('  2. Skip', '  2. Not now'));
  assert.equal(updatePrompt(reformule.join('\n')), null);

  // Et si la reformulation survient entre la détection et la validation :
  const tmux = fakeTmux();
  const seen = updatePrompt(tmux.screen());
  tmux.t = async (...args) =>
    args[0] === 'capture-pane'
      ? { stdout: 'Rien à voir ici', stderr: '', err: null }
      : (tmux.keys.push(args[args.length - 1]), { stdout: '', stderr: '', err: null });

  assert.equal(await dismissUpdate(tmux.t, 's', seen), false);
  assert.equal(tmux.keys.includes('Enter'), false);
});

test('un curseur qu’on n’arrive pas à lire interdit de valider', async () => {
  const nu = MENU.join('\n'); // le menu, mais sans marqueur de sélection
  const seen = updatePrompt(nu);
  assert.equal(seen.selected, null);

  const keys = [];
  const t = async (...args) => {
    if (args[0] === 'capture-pane') return { stdout: nu, stderr: '', err: null };
    keys.push(args[args.length - 1]);
    return { stdout: '', stderr: '', err: null };
  };

  assert.equal(await dismissUpdate(t, 's', seen), false);
  assert.equal(keys.includes('Enter'), false); // on abandonne plutôt que de miser
});

test('l’écran d’accueil normal de Codex ne déclenche rien', () => {
  assert.equal(updatePrompt('│ >_ OpenAI Codex (v0.146.0)\n│ model: gpt-5.6-sol'), null);
  // Le bandeau qui reste APRÈS le passage ne doit pas relancer la manœuvre.
  assert.equal(
    updatePrompt('│ ✨ Update available! 0.146.0 -> 0.146.1\n│ Run npm install -g @openai/codex to update.'),
    null
  );
});

// « Réinitialisation à 15h49 » n'apprend rien sans calcul mental. Pour afficher
// « dans 2 h 14 », il faut d'abord ramener ces textes à un instant absolu — deux
// formats différents, sans année, et chez Codex sans fuseau non plus.
const AOUT_6 = Date.parse('2026-08-06T11:35:00Z'); // 13 h 35 à Paris

test('l’heure de Claude devient un instant absolu, dans son fuseau', () => {
  assert.equal(
    parseResetAt('Aug 6, 3:49pm (Europe/Paris)', AOUT_6),
    '2026-08-06T13:49:00.000Z' // 15 h 49 à Paris, soit 2 h 14 plus tard
  );
  assert.equal(parseResetAt('Jul 31, 12:59pm (UTC)', AOUT_6), '2026-07-31T12:59:00.000Z');
  assert.equal(parseResetAt('Aug 4, 9:00am (UTC)', AOUT_6), '2026-08-04T09:00:00.000Z');
});

test('minuit et midi ne se confondent pas', () => {
  assert.equal(parseResetAt('Aug 6, 12:00am (UTC)', AOUT_6), '2026-08-06T00:00:00.000Z');
  assert.equal(parseResetAt('Aug 6, 12:00pm (UTC)', AOUT_6), '2026-08-06T12:00:00.000Z');
});

test('le format de Codex est lu dans le fuseau du serveur', () => {
  assert.equal(
    parseResetAt('07:01 on 5 Aug', AOUT_6, 'Europe/Paris'),
    '2026-08-05T05:01:00.000Z'
  );
});

test('sans année écrite, on prend celle qui tombe le plus près', () => {
  const saintSylvestre = Date.parse('2026-12-31T22:00:00Z');
  assert.equal(
    parseResetAt('Jan 2, 9:00am (UTC)', saintSylvestre),
    '2027-01-02T09:00:00.000Z' // et non janvier 2026, onze mois en arrière
  );
});

test('un fuseau que le CLI aurait inventé ne fait pas échouer la lecture', () => {
  const iso = parseResetAt('Aug 6, 3:49pm (Middle/Earth)', AOUT_6, 'UTC');
  assert.equal(iso, '2026-08-06T15:49:00.000Z');
});

test('un format inconnu ne produit aucune échéance inventée', () => {
  assert.equal(parseResetAt('dans quelques heures', AOUT_6), null);
  assert.equal(parseResetAt('Aug 32, 3:49pm (UTC)', AOUT_6), null);
  assert.equal(parseResetAt('', AOUT_6), null);
  assert.equal(parseResetAt(null, AOUT_6), null);
});
