'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-asks-'));
  process.env.AGENTHUB_DATA = dir;
  delete require.cache[require.resolve('../lib/asks')];
  return require('../lib/asks');
}

test('une demande est persistante et une seconde remplace celle en attente', () => {
  const asks = fresh();
  asks.create({ convId: 'c1', question: 'Quelle base de donnees ?' });
  asks.create({ convId: 'c1', question: 'Quel hebergeur ?' });
  const pending = asks.list('pending');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].question, 'Quel hebergeur ?');
  // La première n'est pas perdue pour autant : elle reste dans l'historique.
  assert.equal(asks.list().length, 1);
});

test('une demande sans question est refusee', () => {
  const asks = fresh();
  assert.throws(() => asks.create({ convId: 'c1' }), /Question manquante/);
  assert.throws(() => asks.create({ question: 'et alors ?' }), /Conversation manquante/);
});

test('les options se donnent en tableau ou en chaine a barres', () => {
  const asks = fresh();
  assert.deepEqual(asks.parseOptions(['Oui', 'Non']), ['Oui', 'Non']);
  assert.deepEqual(asks.parseOptions('Oui|Non'), ['Oui', 'Non']);
  // Vides et doublons tombent, et le nombre est borné.
  assert.deepEqual(asks.parseOptions('Oui| |Oui|Non'), ['Oui', 'Non']);
  assert.equal(asks.parseOptions('a|b|c|d|e|f|g|h').length, asks.MAX_OPTIONS);
  assert.deepEqual(asks.parseOptions(undefined), []);
});

test('repondre retire la demande des attentes et ne se fait qu une fois', () => {
  const asks = fresh();
  const row = asks.create({ convId: 'c1', question: 'On supprime la table ?' });
  const answered = asks.answer(row.id, 'Non, renomme-la');
  assert.equal(answered.status, 'answered');
  assert.equal(answered.answer, 'Non, renomme-la');
  assert.equal(asks.list('pending').length, 0);
  // Un second clic ne doit pas relancer le travail une deuxième fois.
  assert.equal(asks.answer(row.id, 'Non, renomme-la'), null);
});

test('une reponse vide est refusee', () => {
  const asks = fresh();
  const row = asks.create({ convId: 'c1', question: 'Alors ?' });
  assert.throws(() => asks.answer(row.id, '   '), /Réponse vide/);
  assert.equal(asks.list('pending').length, 1);
});

test('la demande en attente se retrouve par conversation', () => {
  const asks = fresh();
  asks.create({ convId: 'c1', question: 'Q1' });
  const row = asks.create({ convId: 'c2', question: 'Q2' });
  assert.equal(asks.pendingFor('c2').id, row.id);
  assert.equal(asks.pendingFor('c3'), null);
  asks.answer(row.id, 'oui');
  assert.equal(asks.pendingFor('c2'), null);
});

test('oublier une conversation retire ses demandes', () => {
  const asks = fresh();
  asks.create({ convId: 'c1', question: 'Q1' });
  asks.create({ convId: 'c2', question: 'Q2' });
  assert.equal(asks.forget('c1'), 1);
  assert.deepEqual(asks.list().map((r) => r.convId), ['c2']);
});

test('la consigne de reprise rappelle la question et la reponse', () => {
  const asks = fresh();
  const row = asks.create({ convId: 'c1', question: 'On supprime la table ?' });
  const prompt = asks.resumePrompt(asks.answer(row.id, 'Non, renomme-la'));
  // Le turn qui avait posé la question est terminé : la reprise ne peut pas compter
  // sur le contexte du CLI pour savoir à quoi « non » répond.
  assert.match(prompt, /On supprime la table \?/);
  assert.match(prompt, /Non, renomme-la/);
  assert.match(prompt, /Ne repose pas la question/);
});

test('le prompt donne le canal et retient d en abuser', () => {
  const asks = fresh();
  const prompt = asks.promptBlock();
  assert.match(prompt, /AGENTHUB_ASK_URL/);
  assert.match(prompt, /AGENTHUB_CONV_ID/);
  assert.match(prompt, /tranche seul/);
  assert.match(prompt, /ne la recopie jamais/);
});

test("le prompt met l'outil en avant quand il existe, sans cacher la retombee", () => {
  const asks = fresh();
  const prompt = asks.promptBlock('mcp__agenthub__ask_user');
  assert.match(prompt, /mcp__agenthub__ask_user/);
  assert.match(prompt, /sans que tu aies a/);
  // Le curl reste décrit : l'outil peut expirer, et il faut alors savoir quoi faire.
  assert.match(prompt, /AGENTHUB_ASK_URL/);
});

test('une demande est en mode turn par defaut, live sur demande', () => {
  const asks = fresh();
  assert.equal(asks.create({ convId: 'c1', question: 'Q' }).mode, 'turn');
  assert.equal(asks.create({ convId: 'c2', question: 'Q', mode: 'live' }).mode, 'live');
  // Un mode inconnu retombe sur la voie qui marche partout.
  assert.equal(asks.create({ convId: 'c3', question: 'Q', mode: 'modal' }).mode, 'turn');
});

test('repondre debloque l appel d outil suspendu', async () => {
  const asks = fresh();
  const row = asks.create({ convId: 'c1', question: 'On supprime ?', mode: 'live' });
  const waiting = asks.waitFor(row.id, 5000);
  assert.equal(asks.hasWaiter(row.id), true);

  asks.answer(row.id, 'Non');
  const got = await waiting;
  assert.equal(got.answer, 'Non');
  assert.equal(asks.hasWaiter(row.id), false);
});

test('une attente non satisfaite expire et rend la main', async () => {
  const asks = fresh();
  const row = asks.create({ convId: 'c1', question: 'Alors ?', mode: 'live' });
  // Le plafond est un vrai mur : l'agent doit récupérer la main pour retomber sur la voie
  // `turn` plutôt que de se faire couper par le timeout d'outil de son CLI.
  assert.equal(await asks.waitFor(row.id, 20), null);
  assert.equal(asks.get(row.id).status, 'expired');
  assert.equal(asks.list('pending').length, 0);
});

test('une seconde question libere l appel suspendu sur la premiere', async () => {
  const asks = fresh();
  const first = asks.create({ convId: 'c1', question: 'Q1', mode: 'live' });
  const waiting = asks.waitFor(first.id, 5000);
  // Sans ça, l'agent resterait bloqué sur une question que plus personne n'affiche.
  asks.create({ convId: 'c1', question: 'Q2', mode: 'live' });
  assert.equal(await waiting, null);
});

test('le plafond d attente reste sous le mur de cinq minutes des CLIs', () => {
  const asks = fresh();
  // Mesuré le 05/08/2026 : Claude coupe l'appel à cinq minutes, et MCP_TOOL_TIMEOUT ne
  // relève pas ce plafond. Passer au-dessus rendrait notre expiration inatteignable, et
  // l'agent recevrait un échec opaque au lieu d'un message exploitable.
  assert.ok(asks.WAIT_MS + asks.CLI_MARGIN_MS < 5 * 60 * 1000);
});

test('un redemarrage ferme les attentes que personne ne tient plus', () => {
  const asks = fresh();
  const live = asks.create({ convId: 'c1', question: 'Q1', mode: 'live' });
  const turn = asks.create({ convId: 'c2', question: 'Q2' });

  assert.equal(asks.dropWaiters(), 1);
  // La question `live` ne débloquerait plus rien : elle est fermée. La `turn`, elle, se
  // répond toujours — c'est justement la retombée.
  assert.equal(asks.get(live.id).status, 'expired');
  assert.equal(asks.get(turn.id).status, 'pending');
});
