'use strict';

// One entry point for CI and isolated Linux validation. Only source directories are
// inspected: runtime data, worktrees and dependencies must never become check inputs.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function javascriptIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink() || entry.name === 'vendor') return [];
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return javascriptIn(file);
    return /\.(?:c?js)$/.test(entry.name) ? [file] : [];
  });
}

const files = [
  ...fs.readdirSync(root).filter((file) => /\.js$/.test(file)).map((file) => path.join(root, file)),
  ...['lib', 'public', 'scripts', 'test'].flatMap((directory) => javascriptIn(path.join(root, directory))),
].sort();

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status || 1);
}

for (const file of files) run(['--check', file]);
console.log('Syntaxe OK : ' + files.length + ' fichiers source.');
const tests = fs.readdirSync(path.join(root, 'test'))
  .filter((file) => file.endsWith('.test.js')).sort()
  .map((file) => path.join(root, 'test', file));
run(['--test', ...tests]);
