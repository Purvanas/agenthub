'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const MAX_DIFF = 160_000;

async function command(cwd, args) {
  try {
    const { stdout } = await run('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
    });
    return { text: stdout, truncated: stdout.length > MAX_DIFF };
  } catch (err) {
    if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
      return { text: String(err.stdout || ''), truncated: true };
    }
    throw new Error(String(err.stderr || err.message).trim().slice(0, 300));
  }
}

/** Read-only review of a server-discovered branch; never checks out or modifies a file. */
async function review(entry) {
  const cwd = entry.exists && entry.path ? entry.path : entry.repo;
  const target = (entry.state && entry.state.target) || 'HEAD';
  const range = `${target}...${entry.branch}`;
  const common = ['--no-ext-diff', '--no-textconv', '--no-color'];
  const committed = await command(cwd, ['diff', ...common, range, '--']);
  const local = entry.exists
    ? await command(cwd, ['diff', ...common, 'HEAD', '--'])
    : { text: '', truncated: false };
  const status = entry.exists
    ? await command(cwd, ['status', '--short', '--untracked-files=normal'])
    : { text: '', truncated: false };
  const text = [
    committed.text && `Changements commités par rapport à ${target}\n\n${committed.text}`,
    local.text && `Modifications locales non commitées\n\n${local.text}`,
  ].filter(Boolean).join('\n\n');
  return {
    branch: entry.branch, target, status: status.text.slice(0, 20_000),
    text: text.slice(0, MAX_DIFF),
    truncated: committed.truncated || local.truncated || text.length > MAX_DIFF,
  };
}

module.exports = { review };
