'use strict';

// Secrets d'un projet.
//
// La propriété à ne jamais casser : une valeur enregistrée ne doit ressortir nulle part.
// Ni dans ce que l'API renvoie, ni dans le prompt envoyé au modèle, ni dans ce que l'agent
// produit. Ces tests attaquent les trois.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-secrets-'));
process.env.AGENTHUB_DATA = DATA;

const secrets = require('../lib/secrets');

const FOLDER = 'projet-1';
const KEY = 'GEMINI_API_KEY';
const VALUE = 'sk-abcdef0123456789';

test('une valeur enregistrée ressort par l’environnement, jamais par la liste', () => {
  assert.deepEqual(secrets.set(FOLDER, KEY, VALUE), { name: KEY });

  const listed = secrets.list(FOLDER);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, KEY);
  assert.equal(listed[0].length, VALUE.length, 'la longueur aide à repérer un copier-coller tronqué');
  assert.equal(
    JSON.stringify(listed).includes(VALUE),
    false,
    'la valeur ne doit apparaître nulle part dans ce qui part au navigateur'
  );

  assert.equal(secrets.env(FOLDER)[KEY], VALUE);
});

test('les valeurs sont écrites en 0600, hors de portée des autres comptes', () => {
  const file = path.join(secrets.SECRETS_DIR, `${FOLDER}.json`);
  const mode = fs.statSync(file).mode & 0o777;
  // Windows n'a pas de bits POSIX : la vérification n'y a pas de sens.
  if (process.platform !== 'win32') assert.equal(mode, 0o600, mode.toString(8));
});

test('un nom de clé illisible par un shell est refusé', () => {
  // `$mdp-projet` se lit comme `$mdp` suivi de `-projet` : l'agent croirait à une variable
  // vide plutôt qu'à une erreur.
  assert.ok(secrets.set(FOLDER, 'mdp-projet', VALUE).error);
  assert.ok(secrets.set(FOLDER, '2fa', VALUE).error, 'ne peut pas commencer par un chiffre');
  assert.ok(secrets.set(FOLDER, '', VALUE).error);
  assert.ok(!secrets.set(FOLDER, 'mdp_projet', VALUE).error, 'celui-ci est valide');
});

test('une valeur trop courte est refusée plutôt que non masquable', () => {
  const refused = secrets.set(FOLDER, 'PIN', 'ab');
  assert.ok(refused.error);
  assert.ok(refused.error.includes(String(secrets.MIN_LENGTH)));
});

test('le prompt annonce les clés et jamais les valeurs', () => {
  const block = secrets.promptBlock(FOLDER);
  assert.ok(block.includes(`$${KEY}`));
  assert.ok(block.includes('$mdp_projet'));
  assert.equal(block.includes(VALUE), false, 'aucune valeur dans le contexte du modèle');
});

test("sans secret, le prompt n'est pas alourdi", () => {
  assert.equal(secrets.promptBlock('projet-vide'), '');
  assert.equal(secrets.promptBlock(null), '');
});

// --- Masquage ---------------------------------------------------------------

test('une valeur affichée par l’agent est masquée', () => {
  const values = secrets.values(FOLDER);
  const out = secrets.redact(`export KEY=${VALUE} && curl`, values);
  assert.equal(out.includes(VALUE), false);
  assert.ok(out.includes(secrets.MASK));
});

test('toutes les occurrences sont masquées, pas seulement la première', () => {
  const out = secrets.redact(`${VALUE} puis ${VALUE}`, secrets.values(FOLDER));
  assert.equal(out.includes(VALUE), false);
  assert.equal(out.split(secrets.MASK).length - 1, 2);
});

test("une valeur contenue dans une autre ne laisse pas de fragment", () => {
  // Le tri par longueur décroissante existe pour ce cas : masquer d'abord la courte
  // laisserait la fin de la longue en clair.
  secrets.set('imbrique', 'COURT', 'abcd1234');
  secrets.set('imbrique', 'LONG', 'abcd1234-suite-secrete');
  const out = secrets.redact('voici abcd1234-suite-secrete ici', secrets.values('imbrique'));
  assert.equal(out.includes('suite-secrete'), false, out);
});

test('le masquage descend dans les arguments d’un outil', () => {
  // Un agent qui écrit la valeur en clair dans sa commande l'expose par l'appel lui-même,
  // avant même d'en voir le résultat.
  const item = {
    kind: 'tool',
    tool: 'Bash',
    input: { command: `curl -H "Authorization: Bearer ${VALUE}" https://x` },
    result: 'ok',
  };
  const clean = secrets.redactDeep(item, secrets.values(FOLDER));
  assert.equal(clean.input.command.includes(VALUE), false);
  assert.equal(item.input.command.includes(VALUE), true, "l'original n'est pas muté");
});

test('sans secret, les items ne sont pas recopiés inutilement', () => {
  const item = { kind: 'text', text: 'bonjour' };
  assert.equal(secrets.redactDeep(item, []), item, 'même référence');
});

// --- Import d'un .env collé -------------------------------------------------

test('un .env ordinaire est lu ligne par ligne', () => {
  const { entries, skipped } = secrets.parseEnv(
    [
      '# une base',
      '',
      'DATABASE_URL=postgres://u:p@localhost/db',
      'export API_KEY=abc123def',
      'QUOTED="valeur avec espaces"',
      "SIMPLE='sans interpolation'",
      'AVEC_COMMENTAIRE=valeur123 # ceci est ignoré',
    ].join('\n')
  );
  assert.deepEqual(skipped, []);
  assert.deepEqual(entries, [
    { name: 'DATABASE_URL', value: 'postgres://u:p@localhost/db' },
    { name: 'API_KEY', value: 'abc123def' },
    { name: 'QUOTED', value: 'valeur avec espaces' },
    { name: 'SIMPLE', value: 'sans interpolation' },
    { name: 'AVEC_COMMENTAIRE', value: 'valeur123' },
  ]);
});

test('une valeur sur plusieurs lignes est recollée', () => {
  // Le cas réel : une clé privée ou un JSON de service.
  const { entries } = secrets.parseEnv(
    ['PRIVATE_KEY="-----BEGIN KEY-----', 'ligne2', 'ligne3', '-----END KEY-----"', 'APRES=suivante1'].join('\n')
  );
  assert.equal(entries.length, 2);
  assert.equal(
    entries[0].value,
    '-----BEGIN KEY-----\nligne2\nligne3\n-----END KEY-----'
  );
  assert.equal(entries[1].name, 'APRES', 'la clé suivante est bien reprise');
});

test('les échappements ne valent que dans les guillemets doubles', () => {
  const { entries } = secrets.parseEnv(['A="un\\ndeux"', "B='un\\ndeux'"].join('\n'));
  assert.equal(entries[0].value, 'un\ndeux');
  assert.equal(entries[1].value, 'un\\ndeux', "les guillemets simples n'interprètent rien");
});

test('un # dans une valeur quotée n’est pas un commentaire', () => {
  const { entries } = secrets.parseEnv('COULEUR="#ff8800 vif"');
  assert.equal(entries[0].value, '#ff8800 vif');
});

test('une ligne incompréhensible est signalée, pas avalée', () => {
  const { entries, skipped } = secrets.parseEnv(['BONNE=valeur123', 'ceci nest pas une ligne'].join('\n'));
  assert.equal(entries.length, 1);
  assert.equal(skipped.length, 1);
  assert.ok(skipped[0].line.includes('ceci nest pas'));
});

test('un import fusionne, il ne remplace pas tout', () => {
  secrets.set('import', 'DEJA_LA', 'valeur-existante');
  const r = secrets.importEnv('import', 'NOUVELLE=valeur-neuve\nDEJA_LA=valeur-mise-a-jour');

  assert.deepEqual(r.saved, ['NOUVELLE']);
  assert.deepEqual(r.replaced, ['DEJA_LA']);
  assert.equal(secrets.env('import').DEJA_LA, 'valeur-mise-a-jour');
  assert.equal(secrets.env('import').NOUVELLE, 'valeur-neuve');
});

test('ce qui est refusé à l’import est nommé, avec sa raison', () => {
  const r = secrets.importEnv('import', ['mauvais-nom=valeur123', 'TROP_COURT=ab'].join('\n'));
  assert.equal(r.saved.length, 0);
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.find((x) => x.name === 'mauvais-nom').reason.includes('shell'));
  assert.ok(r.rejected.find((x) => x.name === 'TROP_COURT').reason.includes('4'));
});

test('un import entièrement refusé ne touche pas au fichier', () => {
  const before = secrets.list('import').length;
  secrets.importEnv('import', 'PIN=ab');
  assert.equal(secrets.list('import').length, before);
});

test('supprimer une clé la retire de l’environnement', () => {
  assert.equal(secrets.remove(FOLDER, KEY), true);
  assert.equal(secrets.remove(FOLDER, KEY), false, 'une clé déjà retirée ne ment pas');
  assert.equal(secrets.env(FOLDER)[KEY], undefined);
});

test('supprimer un dossier efface son fichier de secrets', () => {
  secrets.set('jetable', 'TOKEN', 'valeur-jetable');
  assert.equal(secrets.list('jetable').length, 1);
  secrets.forget('jetable');
  assert.equal(secrets.list('jetable').length, 0);
  assert.equal(fs.existsSync(path.join(secrets.SECRETS_DIR, 'jetable.json')), false);
});

test('retirer la dernière clé ne laisse pas de fichier vide derrière', () => {
  secrets.set('ephemere', 'A', 'valeur-a');
  secrets.remove('ephemere', 'A');
  assert.equal(fs.existsSync(path.join(secrets.SECRETS_DIR, 'ephemere.json')), false);
});
