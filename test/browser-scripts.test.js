'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicRoot = path.resolve(__dirname, '..', 'public');

test('les scripts classiques de la page partagent un espace global sans collision de déclarations', () => {
  const html = fs.readFileSync(path.join(publicRoot, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].flatMap((match) => {
    if (/\btype\s*=\s*["']module["']/i.test(match[1])) return [];
    const source = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1]);
    return source ? [source[1]] : [];
  });
  assert.ok(scripts.length > 0);
  const stop = Object.freeze({ stopBeforeSideEffects: true });
  const context = vm.createContext({ __agentHubScriptStop: stop });

  for (const url of scripts) {
    assert.ok(url.startsWith('/') && !url.startsWith('//'), 'seules les ressources locales sont attendues');
    const file = path.resolve(publicRoot, url.slice(1).split('?')[0]);
    assert.ok(file.startsWith(publicRoot + path.sep), 'le script doit rester dans public/');
    const source = fs.readFileSync(file, 'utf8');
    // GlobalDeclarationInstantiation runs before the first statement. Stopping there
    // validates the browser's shared lexical namespace without a fake DOM, timers,
    // network requests or evaluating the rest of the application.
    const script = new vm.Script('throw __agentHubScriptStop;\n' + source, { filename: url });
    let thrown;
    try { script.runInContext(context); }
    catch (error) { thrown = error; }
    assert.equal(thrown, stop, 'collision de déclarations dans ' + url + ': ' + (thrown && thrown.message));
  }
});
