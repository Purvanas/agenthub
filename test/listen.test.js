'use strict';

// La reprise est testée contre de vraies sockets, pas contre une simulation : ce qu'on veut
// vérifier, c'est qu'un `listen` qui a échoué peut être relancé sur le même serveur et
// finir par réussir. Un faux répondrait toujours oui.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const listen = require('../lib/listen');

/** Un port libre, obtenu en en réservant un puis en le rendant. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

test('seuls les échecs qui se résolvent en attendant sont réessayés', () => {
  // Interface d'écoute pas encore montée, et port encore tenu par l'instance précédente.
  assert.equal(listen.retryable('EADDRNOTAVAIL'), true);
  assert.equal(listen.retryable('EADDRINUSE'), true);
  // Un port interdit par les droits ne se réglera pas tout seul : il doit remonter.
  assert.equal(listen.retryable('EACCES'), false);
  assert.equal(listen.retryable(undefined), false);
});

test("l'attente croît mais reste bornée", () => {
  let d = listen.FIRST_DELAY_MS;
  for (let i = 0; i < 50; i += 1) d = listen.nextDelay(d);
  // Sans plafond, on finirait par attendre des heures avant de retenter.
  assert.equal(d, listen.MAX_DELAY_MS);
  assert.ok(listen.nextDelay(1000) > 1000);
});

test('une erreur non réessayable remonte au lieu d’être avalée', async () => {
  const server = net.createServer();
  const fatal = [];
  // Port 1 : réservé aux privilèges, donc EACCES pour un utilisateur ordinaire. Le genre
  // d'échec qui ne se réglera pas en attendant — il ne doit pas entrer dans la boucle.
  listen.listenWithRetry(server, {
    port: 1,
    host: '127.0.0.1',
    firstDelayMs: 10,
    onFatal: (err) => fatal.push(err.code),
    onListening: () => {},
  });

  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(fatal.length, 1, `attendu une erreur fatale, reçu ${fatal}`);
  assert.match(fatal[0], /EACCES|EPERM/);
  await close(server).catch(() => {});
});

test('le défaut d’une erreur fatale est de la relancer', () => {
  // Sans `onFatal`, le comportement doit rester celui de Node : ça casse, et ça se voit.
  const fake = {
    handlers: {},
    on(name, fn) {
      this.handlers[name] = fn;
    },
    once(name, fn) {
      this.handlers[name] = fn;
    },
    removeListener() {},
    listen() {},
  };
  listen.listenWithRetry(fake, { port: 1, host: '127.0.0.1', onListening: () => {} });
  assert.throws(() => fake.handlers.error(Object.assign(new Error('nope'), { code: 'EACCES' })));
});

test('un port occupé est réessayé, et la liaison réussit dès qu’il se libère', async () => {
  const port = await freePort();

  // L'instance « précédente », qui n'a pas encore fini de s'arrêter.
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));

  const server = net.createServer();
  const waits = [];
  const listening = new Promise((resolve) => {
    listen.listenWithRetry(server, {
      port,
      host: '127.0.0.1',
      firstDelayMs: 20,
      maxDelayMs: 40,
      onWait: (info) => waits.push(info),
      onListening: resolve,
    });
  });

  // Le temps d'échouer au moins une fois, puis on libère la place.
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(waits.length >= 1, 'aucune tentative en attente');
  assert.equal(waits[0].code, 'EADDRINUSE');
  await close(squatter);

  const info = await listening;
  assert.ok(info.attempts >= 1);
  assert.equal(server.address().port, port);
  await close(server);
});

test('arrêter les tentatives empêche toute liaison ultérieure', async () => {
  const port = await freePort();
  const squatter = net.createServer();
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));

  const server = net.createServer();
  let bound = false;
  const handle = listen.listenWithRetry(server, {
    port,
    host: '127.0.0.1',
    firstDelayMs: 20,
    onListening: () => (bound = true),
  });

  await new Promise((r) => setTimeout(r, 40));
  handle.stop();
  await close(squatter);
  await new Promise((r) => setTimeout(r, 80));

  // La place est libre, mais plus personne ne la réclame.
  assert.equal(bound, false);
  await close(server).catch(() => {});
});
