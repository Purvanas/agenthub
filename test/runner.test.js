'use strict';

// Construction des arguments et traduction des événements.
//
// `buildArgs` existe pour être testable : une ligne de commande fausse ne se voit qu'à
// l'exécution d'un vrai agent, où l'erreur remonte sous une forme méconnaissable — un
// flag inconnu fait sortir le CLI en code 2 avec un message sur stderr, que l'UI affiche
// tel quel. Les schémas de sortie et le format des flux ont été relevés sur les trois
// binaires le 01/08/2026 ; ces tests figent ce qui a été mesuré.

const test = require('node:test');
const assert = require('node:assert');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Avant de charger le runner : il ouvre le dossier des flux de turns au chargement, et un test
// n'a rien à écrire dans le `data/` de l'application.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-runner-'));
process.env.AGENTHUB_DATA = DATA;

const runner = require('../lib/runner');
const asks = require('../lib/asks');

const { buildArgs, mapEvent, splitToolContent, agentPath, partialUsage } = runner;

const USER_BIN = path.join(os.homedir(), '.local', 'bin');

const conv = (over) => ({
  id: 'c1',
  provider: 'claude',
  cwd: '/tmp/x',
  providerSessionId: '00000000-0000-4000-8000-000000000000',
  ...over,
});

/** Valeur qui suit un drapeau, ou undefined si le drapeau est absent. */
function after(args, flag) {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

test('Claude reçoit le texte des sous-agents', () => {
  const args = buildArgs(conv());
  assert.ok(
    args.includes('--forward-subagent-text'),
    'sans ce drapeau, un sous-agent ne remonte que ses appels d’outils'
  );
});

test('session neuve, reprise et fork', () => {
  const fresh = buildArgs(conv());
  assert.equal(after(fresh, '--session-id'), '00000000-0000-4000-8000-000000000000');

  const resumed = buildArgs(conv({ sessionStarted: true }));
  assert.equal(after(resumed, '--resume'), '00000000-0000-4000-8000-000000000000');
  assert.ok(!resumed.includes('--session-id'));

  // Le fork ne nomme pas la session de l'enfant : on laisse le CLI la nommer et on la
  // récupère dans son événement `init`.
  const forked = buildArgs(conv({ forkFrom: 'parent-session' }));
  assert.equal(after(forked, '--resume'), 'parent-session');
  assert.ok(forked.includes('--fork-session'));
  assert.ok(!forked.includes('--session-id'));
});

test("Codex ne sait pas forker : il ouvre une session neuve", () => {
  const forked = buildArgs(conv({ provider: 'codex', forkFrom: 'parent-session' }));
  assert.ok(!forked.includes('--fork-session'));
  assert.equal(after(forked, '--cd'), '/tmp/x');
});

test("`resume` de Codex n'accepte pas --cd", () => {
  const resumed = buildArgs(conv({ provider: 'codex', sessionStarted: true }));
  assert.deepEqual(resumed.slice(0, 3), ['exec', 'resume', '00000000-0000-4000-8000-000000000000']);
  assert.ok(!resumed.includes('--cd'));
});

test("l'effort suit le drapeau propre à chaque CLI", () => {
  assert.equal(after(buildArgs(conv({ effort: 'high' })), '--effort'), 'high');
  assert.equal(
    after(buildArgs(conv({ provider: 'grok', effort: 'high' }), null, { promptPath: '/tmp/p' }), '--reasoning-effort'),
    'high'
  );
  // Codex n'a pas de drapeau : l'effort passe par une surcharge de config.
  assert.ok(buildArgs(conv({ provider: 'codex', effort: 'high' })).includes('model_reasoning_effort=high'));
});

// --- Sortie structurée ------------------------------------------------------

const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };

test('Claude et Grok prennent le schéma en clair', () => {
  const claude = buildArgs(conv(), null, { schema: SCHEMA });
  assert.deepEqual(JSON.parse(after(claude, '--json-schema')), SCHEMA);

  const grok = buildArgs(conv({ provider: 'grok' }), null, {
    schema: SCHEMA,
    promptPath: '/tmp/p.json',
  });
  assert.deepEqual(JSON.parse(after(grok, '--json-schema')), SCHEMA);
  // `--json-schema` est documenté chez Grok comme impliquant `--output-format json`.
  // Vérifié le 01/08/2026 : le format explicite prime, le flux reste celui qu'on lit.
  assert.equal(after(grok, '--output-format'), 'streaming-messages-json');
});

test('Codex veut le schéma sur disque', () => {
  const args = buildArgs(conv({ provider: 'codex' }), null, {
    schema: SCHEMA,
    schemaPath: '/tmp/s.json',
  });
  assert.equal(after(args, '--output-schema'), '/tmp/s.json');
  assert.ok(!args.includes('--json-schema'));
});

test('sans schéma demandé, aucun drapeau de sortie structurée', () => {
  for (const provider of ['claude', 'codex', 'grok']) {
    const args = buildArgs(conv({ provider }), null, { promptPath: '/tmp/p.json' });
    assert.ok(!args.includes('--json-schema'), provider);
    assert.ok(!args.includes('--output-schema'), provider);
  }
});

// --- Récupération de l'objet structuré --------------------------------------
//
// Les événements ci-dessous reproduisent la forme relevée sur les vrais flux le
// 01/08/2026, réduite à ce qui compte ici.

/** Contexte minimal : les traducteurs n'appellent les rappels que sur d'autres événements. */
const context = (schema) => ({ schema: schema || null, state: {}, session() {}, delta() {} });

/** Dernier item `result` produit par une suite d'événements. */
function replay(provider, events, schema) {
  const ctx = context(schema);
  let result = null;
  for (const evt of events) {
    for (const item of mapEvent(provider, evt, ctx)) {
      if (item.kind === 'result') result = item;
    }
  }
  return result;
}

const agentMessage = (text) => ({
  type: 'item.completed',
  item: { id: 'item_1', type: 'agent_message', text },
});

test('Claude publie déjà l’objet validé, on le relaie', () => {
  const result = replay(
    'claude',
    [{ type: 'result', subtype: 'success', structured_output: { ok: true } }],
    SCHEMA
  );
  assert.deepEqual(result.structuredOutput, { ok: true });
});

test('Codex : la réponse finale est le JSON, on la relit', () => {
  const result = replay(
    'codex',
    [agentMessage('{"count":4,"files":["a.txt"]}'), { type: 'turn.completed', usage: {} }],
    SCHEMA
  );
  assert.deepEqual(result.structuredOutput, { count: 4, files: ['a.txt'] });
});

test("Codex : une tentative ratée n'écrase pas une réponse valide", () => {
  // Vu en vrai : Codex répond une première fois trop vite, puis se corrige. L'inverse
  // reste possible — une phrase après le JSON ne doit pas effacer le JSON.
  const result = replay(
    'codex',
    [
      agentMessage('{"count":4,"files":["a.txt"]}'),
      agentMessage('Voilà, c’est fait.'),
      { type: 'turn.completed', usage: {} },
    ],
    SCHEMA
  );
  assert.deepEqual(result.structuredOutput, { count: 4, files: ['a.txt'] });
});

// --- Navigateur MCP ---------------------------------------------------------

const BROWSER = { name: 'playwright', url: 'http://localhost:3902/mcp' };
const MCP = { playwright: { type: 'http', url: BROWSER.url } };

test('Claude reçoit ses serveurs MCP par fichier de configuration', () => {
  const args = buildArgs(conv(), null, { mcp: MCP, mcpPath: '/tmp/x.mcp.json' });
  assert.equal(after(args, '--mcp-config'), '/tmp/x.mcp.json');
  // Surtout pas : il ferait disparaître les serveurs MCP déjà configurés du compte.
  assert.ok(!args.includes('--strict-mcp-config'));
});

test('Codex reçoit ses serveurs MCP en surcharge de config', () => {
  const args = buildArgs(conv({ provider: 'codex' }), null, { mcp: MCP });
  assert.ok(args.includes(`mcp_servers.playwright.url=${BROWSER.url}`), args.join(' '));
});

test('seul un serveur qui retient un appel fait relever le plafond de Codex', () => {
  const withHold = buildArgs(conv({ provider: 'codex' }), null, {
    mcp: { agenthub: { type: 'http', url: 'http://x/mcp/c1', holdsLong: true } },
  });
  // Le navigateur n'a aucune raison de bénéficier d'un plafond de dix minutes : une page
  // qui ne répond pas doit échouer vite.
  assert.ok(withHold.some((a) => String(a).startsWith('mcp_servers.agenthub.tool_timeout_sec=')));
  const browserOnly = buildArgs(conv({ provider: 'codex' }), null, { mcp: MCP });
  assert.ok(!browserOnly.some((a) => String(a).includes('tool_timeout_sec')));
});

test('sans serveur MCP, aucun drapeau', () => {
  for (const provider of ['claude', 'codex', 'grok']) {
    const args = buildArgs(conv({ provider }), null, { promptPath: '/tmp/p.json' });
    assert.ok(!args.includes('--mcp-config'), provider);
    assert.ok(!args.some((a) => String(a).startsWith('mcp_servers.')), provider);
  }
});

test("le serveur d'agentHub porte la conversation dans son URL", () => {
  const servers = runner.mcpServersFor(conv({ id: 'abc-123' }), {});
  // C'est ce qui empêche un agent de poser une question au nom d'une autre conversation :
  // il n'a jamais l'occasion de la désigner.
  assert.match(servers.agenthub.url, /\/abc-123$/);
  assert.equal(servers.agenthub.type, 'http');
  assert.equal(servers.agenthub.holdsLong, true);
  // Sans navigateur demandé, il n'y est pas.
  assert.deepEqual(Object.keys(servers), ['agenthub']);
});

test('les marqueurs internes ne partent pas dans la configuration du CLI', () => {
  const json = runner.mcpConfigJson(runner.mcpServersFor(conv({ id: 'abc' }), {}));
  assert.equal(json.mcpServers.agenthub.holdsLong, undefined);
  assert.ok(json.mcpServers.agenthub.url);
});

test('le plafond imposé au CLI dépasse notre propre attente', () => {
  // On veut expirer les premiers, pour rendre à l'agent un message exploitable plutôt que
  // l'échec opaque d'un appel coupé par son CLI.
  assert.ok(runner.cliTimeoutSeconds() * 1000 > asks.WAIT_MS);
});

// --- Résultats d'outils contenant des images --------------------------------
//
// Le régime précédent, `content.map((c) => c.text)`, transformait une capture d'écran en
// chaîne vide. C'est le cas que ces tests protègent.

test('un résultat en texte simple passe tel quel', () => {
  assert.deepEqual(splitToolContent('sortie brute'), { text: 'sortie brute', images: [] });
  assert.deepEqual(splitToolContent(null), { text: '', images: [] });
});

test('une image au format Anthropic est extraite (Claude, Grok)', () => {
  const { text, images } = splitToolContent([
    { type: 'text', text: 'Capture prise' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
  ]);
  assert.equal(text, 'Capture prise');
  assert.deepEqual(images, [{ mime: 'image/png', base64: 'AAA' }]);
});

test('une image au format MCP natif est extraite (Codex)', () => {
  const { text, images } = splitToolContent([
    { type: 'image', mimeType: 'image/jpeg', data: 'BBB' },
    { type: 'text', text: 'après' },
  ]);
  assert.equal(text, 'après');
  assert.deepEqual(images, [{ mime: 'image/jpeg', base64: 'BBB' }]);
});

test('plusieurs captures dans un seul résultat', () => {
  const { images } = splitToolContent([
    { type: 'image', mimeType: 'image/png', data: 'A' },
    { type: 'image', source: { media_type: 'image/webp', data: 'B' } },
  ]);
  assert.equal(images.length, 2);
  assert.equal(images[1].mime, 'image/webp');
});

// --- Fichiers texte joints ------------------------------------------------
//
// Ils ne doivent jamais partir sur `--image` : Codex refuserait le turn. Leur
// contenu ne doit pas non plus entrer dans le prompt : l'agent les lit dans le
// projet, en entier ou en partie.

test('un json joint est copié dans le projet, et son contenu reste hors du prompt', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-piece-'));
  const file = path.join(DATA, 'fiche.json');
  const marker = 'MARQUEUR-QUI-NE-DOIT-PAS-ENTRER-DANS-LE-PROMPT';
  fs.writeFileSync(file, `{"secret":"${marker}"}\n`);
  const out = runner.appendAttachedFiles(
    'Lis ça.',
    [{ path: file, name: 'fiche.json', kind: 'text' }],
    cwd
  );
  assert.match(out, /Lis ça\./);
  assert.match(out, /fiche\.json → \.agenthub\/pieces-jointes\/fiche\.json/);
  assert.equal(out.includes(marker), false);
  const placed = path.join(cwd, '.agenthub', 'pieces-jointes', 'fiche.json');
  assert.equal(fs.readFileSync(placed, 'utf8').includes(marker), true);
  assert.equal(fs.readFileSync(path.join(cwd, '.agenthub', 'pieces-jointes', '.gitignore'), 'utf8'), '*\n');
});

test('un second fichier du même nom n’écrase pas le premier', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-piece-'));
  const file = path.join(DATA, 'fiche-bis.json');
  fs.writeFileSync(file, '{"n":1}\n');
  const item = { path: file, name: 'fiche.json', kind: 'text' };
  runner.appendAttachedFiles('un', [item], cwd);
  fs.writeFileSync(file, '{"n":2}\n');
  const out = runner.appendAttachedFiles('deux', [item], cwd);
  assert.match(out, /fiche-2\.json/);
  const dir = path.join(cwd, '.agenthub', 'pieces-jointes');
  assert.equal(fs.readFileSync(path.join(dir, 'fiche.json'), 'utf8'), '{"n":1}\n');
  assert.equal(fs.readFileSync(path.join(dir, 'fiche-2.json'), 'utf8'), '{"n":2}\n');
});

test('un nom qui remonte les dossiers reste dans le dossier des pièces', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-piece-'));
  const file = path.join(DATA, 'source.json');
  fs.writeFileSync(file, '{}\n');
  const out = runner.appendAttachedFiles(
    'x',
    [{ path: file, name: '../../etc/passwd.json', kind: 'text' }],
    cwd
  );
  assert.match(out, /pieces-jointes\/passwd\.json/);
  assert.equal(fs.existsSync(path.join(cwd, '.agenthub', 'pieces-jointes', 'passwd.json')), true);
  assert.equal(fs.existsSync(path.join(cwd, 'passwd.json')), false);
});

test('sans dossier de projet, on donne le chemin d’origine et rien du contenu', () => {
  const file = path.join(DATA, 'orphelin.md');
  const marker = 'CONTENU-ORPHELIN-HORS-PROMPT';
  fs.writeFileSync(file, `# ${marker}\n`);
  const out = runner.appendAttachedFiles('voici', [{ path: file, name: 'orphelin.md', kind: 'text' }]);
  assert.ok(out.includes(file));
  assert.equal(out.includes(marker), false);
});

test('une image ne change pas le texte du prompt', () => {
  assert.equal(runner.appendAttachedFiles('salut', ['/tmp/photo.png']), 'salut');
});

test('Codex ne reçoit un json ni en --image, et garde les vraies images', () => {
  const args = buildArgs(conv({ provider: 'codex' }), [
    '/tmp/photo.png',
    { path: '/tmp/fiche.json', name: 'fiche.json', kind: 'text' },
  ]);
  const images = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--image') images.push(args[i + 1]);
  }
  assert.deepEqual(images, ['/tmp/photo.png']);
});

test("une image sans données n'est pas retenue", () => {
  const { images } = splitToolContent([{ type: 'image', mimeType: 'image/png', data: '' }]);
  assert.deepEqual(images, []);
});

test("un bloc d'un type inconnu est montré plutôt que perdu", () => {
  const { text } = splitToolContent([{ type: 'tool_reference', name: 'WebFetch' }]);
  assert.ok(text.includes('tool_reference'), text);
});

test('sans schéma demandé, rien n’est relu ni deviné', () => {
  const result = replay('codex', [
    agentMessage('{"count":4}'),
    { type: 'turn.completed', usage: {} },
  ]);
  assert.equal(result.structuredOutput, null);
});

// Le PATH des agents. Ces tests existent parce que l'erreur qu'ils préviennent est muette :
// un binaire absent du PATH sort en 127 sans dire lequel, et le PATH n'est journalisé nulle
// part. C'est exactement comme ça qu'un hook `pre-push` a échoué le 03/08/2026.

/** Assemble un PATH avec le séparateur de la plateforme : `:` ici, `;` sous Windows. */
const asPath = (...dirs) => dirs.join(path.delimiter);

test('le dossier binaire de l’utilisateur est ajouté au PATH', () => {
  assert.equal(agentPath(asPath('/usr/bin', '/bin')), asPath(USER_BIN, '/usr/bin', '/bin'));
});

test('le PATH hérité est conservé en entier, et dans son ordre', () => {
  // Celui que PM2 transmet réellement, relevé le 03/08/2026.
  const inherited = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin'];
  const dirs = agentPath(asPath(...inherited)).split(path.delimiter);
  assert.deepEqual(dirs.slice(1), inherited, 'aucun dossier hérité ne doit disparaître');
});

test('un dossier déjà présent n’est pas dupliqué', () => {
  // Sinon le PATH grossirait à chaque couche qui croit devoir l'enrichir, et un doublon
  // masquerait quelle occurrence a réellement servi à résoudre un binaire.
  const dirs = agentPath(asPath('/usr/bin', USER_BIN)).split(path.delimiter);
  assert.equal(dirs.filter((d) => d === USER_BIN).length, 1);
  assert.equal(dirs[0], USER_BIN, 'il doit passer en tête, pas rester où il était');
});

test('un PATH vide ne produit pas de dossier fantôme', () => {
  // Un séparateur en trop est interprété par le shell comme « le dossier courant », ce qui
  // ferait chercher les binaires dans le dépôt de l'utilisateur. Jamais.
  assert.equal(agentPath(''), USER_BIN);
  assert.equal(
    agentPath(asPath('/usr/bin', '', '/bin')),
    asPath(USER_BIN, '/usr/bin', '/bin'),
    'un segment vide doit être retiré, pas propagé'
  );
});

// --- Consommation d'un turn coupé -----------------------------------------
//
// Un turn tué par un redémarrage n'émet jamais son `result`, donc jamais son relevé de
// consommation. On le reconstitue depuis le flux, qui porte l'usage de chaque appel API.

/** Écrit un flux de turn là où le runner ira le lire. */
function stream(convId, lines) {
  const file = path.join(DATA, 'turns', `${convId}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

const assistant = (id, model, over) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      model,
      usage: {
        input_tokens: 2,
        output_tokens: 5,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 100 },
        cache_read_input_tokens: 1000,
        ...over,
      },
    },
  });

test('un turn coupé rend sa consommation, comptée une fois par appel API', () => {
  // Le piège : Claude Code émet un événement `assistant` PAR BLOC DE CONTENU, tous porteurs du
  // même message et du même relevé. Une réflexion suivie de deux appels d'outils fait donc
  // trois événements pour un seul appel API — les sommer triplerait la facture.
  stream('c-coupe', [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' }),
    assistant('msg_1', 'claude-opus-5'),
    assistant('msg_1', 'claude-opus-5'),
    assistant('msg_1', 'claude-opus-5'),
    assistant('msg_2', 'claude-haiku-4-5', { output_tokens: 7 }),
    'ceci n’est pas du JSON et ne doit rien casser',
  ]);

  const tally = partialUsage('c-coupe', 'claude');
  assert.deepEqual(Object.keys(tally).sort(), ['claude-haiku-4-5', 'claude-opus-5']);
  assert.equal(tally['claude-opus-5'].outputTokens, 5, 'trois événements, un seul appel');
  assert.equal(tally['claude-opus-5'].cacheReadInputTokens, 1000);
  assert.equal(
    tally['claude-opus-5'].cacheCreation1hInputTokens,
    100,
    'la part écrite pour une heure coûte le double : elle ne vient que d’ici'
  );
  assert.equal(tally['claude-haiku-4-5'].outputTokens, 7, 'chaque modèle a son compte');
});

test('sans relevé dans le flux, rien n’est inventé', () => {
  stream('c-muet', [JSON.stringify({ type: 'system', subtype: 'init' })]);
  assert.equal(partialUsage('c-muet', 'claude'), null);
  assert.equal(partialUsage('jamais-lance', 'claude'), null, 'flux absent');
  assert.equal(
    partialUsage('c-coupe', 'codex'),
    null,
    'Codex ne publie rien en cours de turn : son cumul de session rattrape au turn suivant'
  );
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));
