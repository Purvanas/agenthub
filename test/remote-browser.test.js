'use strict';

const test = require('node:test');
const assert = require('node:assert');

const browser = require('../lib/remote-browser');

test('une adresse sans protocole devient une adresse https', () => {
  assert.equal(browser.safeUrl('vercel.com/login'), 'https://vercel.com/login');
});

test('seuls http et https peuvent etre ouverts', () => {
  assert.throws(() => browser.safeUrl('file:///etc/passwd'), /http et https/);
  assert.throws(() => browser.safeUrl('javascript:alert(1)'), /http et https/);
});

test('une adresse vide ouvre une page neutre utilisable', () => {
  assert.equal(browser.safeUrl(''), 'https://www.google.com/');
});

test('l etat public ne divulgue aucun detail du profil', () => {
  const state = browser.view();
  assert.equal('profile' in state, false);
  assert.equal('playwright' in state, false);
});
