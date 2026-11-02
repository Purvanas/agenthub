'use strict';

// Notification de fin de turn : qui reçoit quoi, et dans quel format.
//
// Rien n'est envoyé ici — `send` fait du réseau, le reste est pur et c'est le reste qui
// décide. La règle à ne pas casser : `enabled: false` coupe tout, y compris ce qu'un
// déclencheur réclame explicitement.

const test = require('node:test');
const assert = require('node:assert');

const notify = require('../lib/notify');

const ON = { enabled: true, events: ['error', 'stopped'] };

test('sans configuration active, rien ne part', () => {
  for (const mode of notify.MODES) {
    for (const outcome of notify.OUTCOMES) {
      assert.equal(notify.shouldNotify({ enabled: false }, outcome, mode), false);
      assert.equal(notify.shouldNotify(null, outcome, mode), false);
    }
  }
});

test('sans réglage de déclencheur, la liste globale décide', () => {
  assert.equal(notify.shouldNotify(ON, 'error', 'inherit'), true);
  assert.equal(notify.shouldNotify(ON, 'stopped', 'inherit'), true);
  assert.equal(notify.shouldNotify(ON, 'done', 'inherit'), false);
  assert.equal(notify.shouldNotify(ON, 'done', undefined), false);
});

test('un déclencheur peut forcer son propre filtre', () => {
  assert.equal(notify.shouldNotify(ON, 'done', 'always'), true);
  assert.equal(notify.shouldNotify(ON, 'error', 'never'), false);
  assert.equal(notify.shouldNotify(ON, 'done', 'error'), false);
  assert.equal(notify.shouldNotify(ON, 'stopped', 'error'), true);
});

test('une liste globale absente ne notifie que les échecs', () => {
  assert.equal(notify.shouldNotify({ enabled: true }, 'error', 'inherit'), true);
  assert.equal(notify.shouldNotify({ enabled: true }, 'done', 'inherit'), false);
});

// --- Contenu --------------------------------------------------------------

const CONV = {
  id: 'abc-123',
  title: 'Veille des logs',
  provider: 'claude',
  model: 'opus',
  cwd: '.',
  lastCostUsd: 0.0421,
};

test('le message dit ce qui a échoué, où, et comment y aller', () => {
  const msg = notify.buildMessage({
    conv: CONV,
    outcome: 'error',
    error: 'ENOENT: dossier introuvable',
    appUrl: 'http://127.0.0.1:3901/',
    triggerName: 'Veille',
  });

  assert.equal(msg.title, 'Veille · Agent en échec');
  assert.match(msg.message, /Veille des logs/);
  assert.match(msg.message, /claude · opus — \./);
  assert.match(msg.message, /ENOENT/);
  assert.match(msg.message, /http:\/\/127\.0\.0\.1:3901\/#abc-123/);
  assert.equal(msg.priority, 4);
});

test('une réussite est plus discrète et sans bloc d\'erreur', () => {
  const msg = notify.buildMessage({ conv: CONV, outcome: 'done', appUrl: '' });
  assert.equal(msg.title, 'Agent terminé');
  assert.equal(msg.priority, 3);
  assert.doesNotMatch(msg.message, /http/);
  assert.deepEqual(msg.tags, ['white_check_mark']);
});

test('un coût minuscule ne s\'affiche pas à 0,00 $', () => {
  const msg = notify.buildMessage({ conv: { ...CONV, lastCostUsd: 0.0004 }, outcome: 'done' });
  assert.match(msg.message, /0\.0004 \$/);

  const gros = notify.buildMessage({ conv: { ...CONV, lastCostUsd: 1.5 }, outcome: 'done' });
  assert.match(gros.message, /1\.50 \$/);

  const sans = notify.buildMessage({ conv: { ...CONV, lastCostUsd: 0 }, outcome: 'done' });
  assert.doesNotMatch(sans.message, /Coût/);
});

test('une erreur très longue est tronquée', () => {
  const msg = notify.buildMessage({ conv: CONV, outcome: 'error', error: 'x'.repeat(2000) });
  assert.ok(msg.message.length < 900);
});

// --- Transport ------------------------------------------------------------

const PAYLOAD = { title: 'Titre accentué', message: 'corps', priority: 4, tags: ['x'] };

test('ntfy est publié en JSON à la racine, sujet dans le corps', () => {
  const req = notify.buildRequest(
    { format: 'ntfy', url: 'https://ntfy.sh/', topic: 'agenthub' },
    PAYLOAD
  );
  assert.equal(req.url, 'https://ntfy.sh');
  const body = JSON.parse(req.body);
  assert.equal(body.topic, 'agenthub');
  // Le titre passe par le corps JSON, pas par un en-tête : les en-têtes ntfy ne sont pas
  // fiables en UTF-8 et un titre accentué y arrivait déformé.
  assert.equal(body.title, 'Titre accentué');
  assert.equal(req.headers['Content-Type'], 'application/json');
});

test('ntfy sans sujet est une erreur de configuration explicite', () => {
  // Le message nomme l'endroit où corriger : il finit sous les yeux de quelqu'un qui
  // vient de cliquer sur « Envoyer une notification d'essai ».
  assert.throws(() => notify.buildRequest({ format: 'ntfy' }, PAYLOAD), /sujet ntfy.*Paramètres/);
});

test('un webhook maison reçoit la charge brute sur son URL', () => {
  const req = notify.buildRequest(
    { format: 'json', url: 'https://exemple.test/hook', headers: { Authorization: 'Bearer x' } },
    PAYLOAD
  );
  assert.equal(req.url, 'https://exemple.test/hook');
  assert.equal(req.headers.Authorization, 'Bearer x');
  assert.deepEqual(JSON.parse(req.body), PAYLOAD);
});

test('un webhook sans URL est refusé avant tout appel réseau', () => {
  assert.throws(() => notify.buildRequest({ format: 'json' }, PAYLOAD), /url.*Paramètres/);
});

// --- Répondre depuis la notification --------------------------------------
//
// Répondre demandait d'ouvrir l'application, de retrouver la conversation et de cliquer. Les
// boutons de ntfy font la requête HTTP depuis le téléphone lui-même — ce qui marche si
// le téléphone peut joindre l'app (même réseau / VPN).

const ASK = {
  id: 'ask-1',
  convId: 'abc-123',
  question: 'On supprime la branche ?',
  options: ['Oui', 'Non'],
};

test('chaque option devient un bouton qui poste la reponse', () => {
  const actions = notify.askActions(ASK, 'http://127.0.0.1:3901/');
  assert.deepEqual(
    actions.map((a) => a.label),
    ['Oui', 'Non', 'Ouvrir']
  );
  const oui = actions[0];
  assert.equal(oui.action, 'http');
  assert.equal(oui.method, 'POST');
  assert.equal(oui.url, 'http://127.0.0.1:3901/api/asks/ask-1/answer');
  assert.deepEqual(JSON.parse(oui.body), { answer: 'Oui' });
  // Sans quoi la notification reste affichée et on répond deux fois — refusé par le
  // serveur, mais ça ressemble à un échec.
  assert.equal(oui.clear, true);
});

test('le lien vers l app survit a la troncature, les options non', () => {
  const actions = notify.askActions({ ...ASK, options: ['A', 'B', 'C', 'D'] }, 'http://x.test');
  assert.equal(actions.length, notify.MAX_ACTIONS);
  // ntfy refuse la publication entière au-delà de trois actions : ce sont les options qu'on
  // tronque, jamais le lien — sinon la quatrième réponse ne serait atteignable nulle part.
  assert.deepEqual(
    actions.map((a) => a.label),
    ['A', 'B', 'Ouvrir']
  );
});

test('une question sans option ne propose que d ouvrir', () => {
  const actions = notify.askActions({ ...ASK, options: [] }, 'http://x.test');
  assert.deepEqual(
    actions.map((a) => a.action),
    ['view']
  );
});

// Un bouton qui pointe nulle part échoue en silence : c'est pire que pas de bouton.
test('sans url d application, aucun bouton', () => {
  assert.deepEqual(notify.askActions(ASK, ''), []);
  assert.deepEqual(notify.askActions(null, 'http://x.test'), []);
});

test('les actions voyagent dans la publication ntfy, et seulement si elles existent', () => {
  const withAsk = notify.buildMessage({
    conv: CONV,
    outcome: 'ask',
    ask: ASK,
    appUrl: 'http://x.test',
  });
  const body = JSON.parse(
    notify.buildRequest({ format: 'ntfy', topic: 't' }, withAsk).body
  );
  assert.equal(body.actions.length, 3);

  const plain = notify.buildMessage({ conv: CONV, outcome: 'done', appUrl: 'http://x.test' });
  const bare = JSON.parse(notify.buildRequest({ format: 'ntfy', topic: 't' }, plain).body);
  assert.equal('actions' in bare, false);
});
