'use strict';

// Geler une session : en faire une copie qui n'évoluera plus.
//
// Le comportement mesuré le 03/08/2026 et que ce module exploite : une session Claude est un
// fichier `<uuid>.jsonl`, et `--resume` accepte une copie nue de ce fichier. On fait retenir
// 111, on copie, on remplace par 999 dans l'originale — la copie répond toujours 111.
//
// Ces tests ne relancent pas de CLI : ils protègent la mécanique de copie, notamment le fait
// que la session soit **cherchée** et non déduite du chemin de travail par une règle
// d'encodage qui n'est pas documentée.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-home-'));
// `os.homedir()` est lu à chaque appel : on peut donc le détourner pour le test.
const realHome = os.homedir;
os.homedir = () => HOME;

const sessions = require('../lib/sessions');

const PROJECT_DIR = path.join(HOME, '.claude', 'projects', '-tmp-un-projet');
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

fs.mkdirSync(PROJECT_DIR, { recursive: true });
fs.writeFileSync(path.join(PROJECT_DIR, `${SESSION}.jsonl`), '{"type":"user","text":"111"}\n');

test('seul Claude est déclaré gelable', () => {
  // Une session Grok est un dossier avec un verrou : la copier à l'aveugle serait un pari, et
  // un pari perdu donnerait un contexte non gelé en prétendant l'avoir gelé.
  assert.equal(sessions.supports('claude'), true);
  assert.equal(sessions.supports('grok'), false);
  assert.equal(sessions.supports('codex'), false);
});

test('la session est trouvée sans deviner l’encodage du chemin', () => {
  const found = sessions.findClaude(SESSION);
  assert.ok(found, 'trouvée par balayage des sous-dossiers');
  assert.ok(found.endsWith(`${SESSION}.jsonl`));
  assert.equal(sessions.findClaude('introuvable-0000'), null);
});

test('geler produit une copie indépendante, dans le même dossier', () => {
  const frozen = sessions.freeze('claude', SESSION);
  assert.ok(frozen && frozen.sessionId);
  assert.notEqual(frozen.sessionId, SESSION);
  assert.equal(path.dirname(frozen.file), PROJECT_DIR, 'le dossier dépend du dossier de travail');

  // Modifier l'originale ne doit rien changer à la copie : c'est tout l'intérêt.
  fs.appendFileSync(path.join(PROJECT_DIR, `${SESSION}.jsonl`), '{"type":"user","text":"999"}\n');
  assert.equal(fs.readFileSync(frozen.file, 'utf8').includes('999'), false);

  sessions.forget('claude', frozen.sessionId);
});

test('un fournisseur non gelable ou une session absente répondent null', () => {
  assert.equal(sessions.freeze('grok', SESSION), null);
  assert.equal(sessions.freeze('claude', 'jamais-ecrite'), null);
  assert.equal(sessions.freeze('claude', null), null);
});

test('oublier une copie efface son fichier', () => {
  const frozen = sessions.freeze('claude', SESSION);
  assert.equal(fs.existsSync(frozen.file), true);
  assert.equal(sessions.forget('claude', frozen.sessionId), true);
  assert.equal(fs.existsSync(frozen.file), false);
  assert.equal(sessions.forget('claude', frozen.sessionId), false, 'oublier deux fois ne ment pas');
});

test.after(() => {
  os.homedir = realHome;
  fs.rmSync(HOME, { recursive: true, force: true });
});
