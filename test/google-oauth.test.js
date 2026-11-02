'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function fresh() {
  process.env.AGENTHUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-google-'));
  delete require.cache[require.resolve('../lib/google-oauth')];
  return require('../lib/google-oauth');
}

test('la configuration garde le secret hors de sa vue publique', () => {
  const google = fresh();
  const view = google.configure({
    clientId: '123.apps.googleusercontent.com',
    clientSecret: 'secret-suffisamment-long',
    groups: ['drive'],
  });
  assert.equal(view.configured, true);
  assert.equal('clientSecret' in view, false);
  assert.deepEqual(view.groups, ['identity', 'drive']);
  assert.equal(fs.statSync(google.CONFIG_FILE).mode & 0o777, 0o600);
});

test('les scopes sont dedupliques et l identite est toujours demandee', () => {
  const google = fresh();
  assert.deepEqual(google.scopes(['identity', 'identity']), ['openid', 'email', 'profile']);
});

test('l URL d autorisation demande un refresh token et porte le callback', () => {
  const google = fresh();
  google.configure({
    clientId: '123.apps.googleusercontent.com',
    clientSecret: 'secret-suffisamment-long',
    groups: ['calendar'],
  });
  const url = new URL(google.begin().url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('redirect_uri'), google.callbackUrl());
  assert.match(url.searchParams.get('scope'), /calendar/);
});

test('le state OAuth survit a un rechargement du module', () => {
  const google = fresh();
  google.configure({
    clientId: '123.apps.googleusercontent.com',
    clientSecret: 'secret-suffisamment-long',
    groups: [],
  });
  const state = google.begin().state;
  assert.equal(fs.statSync(google.STATES_FILE).mode & 0o777, 0o600);
  delete require.cache[require.resolve('../lib/google-oauth')];
  const reloaded = require('../lib/google-oauth');
  const saved = JSON.parse(fs.readFileSync(reloaded.STATES_FILE, 'utf8'));
  assert.equal(saved[0].state, state);
});

test('un identifiant qui n est pas un client Google est refuse', () => {
  const google = fresh();
  assert.throws(
    () => google.configure({ clientId: 'autre', clientSecret: 'secret-suffisamment-long' }),
    /Client ID/
  );
});

test('le proxy refuse tout ce qui ne vise pas googleapis.com', () => {
  const google = fresh();
  assert.equal(google.googleApiUrl('https://www.googleapis.com/drive/v3/files').hostname, 'www.googleapis.com');
  assert.throws(() => google.googleApiUrl('https://googleapis.com.evil.test/x'), /googleapis/);
  assert.throws(() => google.googleApiUrl('http://www.googleapis.com/x'), /googleapis/);
});
