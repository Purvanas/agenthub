'use strict';

// Faux CLI Claude utilisé uniquement par les tests critiques. Son stdout reproduit le JSONL
// réel, jusque dans une ligne UTF-8 coupée au milieu d'un caractère pendant le redémarrage.
const fs = require('node:fs');
const path = require('node:path');

const control = process.env.AGENTHUB_TEST_CONTROL_DIR;
const convId = process.env.AGENTHUB_CONV_ID || `service-${process.pid}`;
if (!control) throw new Error('AGENTHUB_TEST_CONTROL_DIR manquant');
// A killed test runner cannot leave a detached fake agent alive indefinitely.
const lifetime = setTimeout(() => process.exit(124), 60_000);
lifetime.unref();
fs.mkdirSync(control, { recursive: true });

const marker = (prefix) => path.join(control, `${prefix}-${convId}`);
fs.writeFileSync(marker('pid'), String(process.pid));

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });

function line(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

process.stdin.on('end', () => {
  line({ type: 'system', subtype: 'init', session_id: `fixture-session-${convId}` });
  line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'flux fixture' } },
  });

  const assistant = Buffer.from(JSON.stringify({
    type: 'assistant',
    message: {
      id: `assistant-${convId}`,
      model: 'fixture-v1',
      usage: { input_tokens: Math.max(1, prompt.length), output_tokens: 4 },
      content: [{ type: 'text', text: 'Réponse finale fixture' }],
    },
  }), 'utf8');
  const accent = assistant.indexOf(Buffer.from('é', 'utf8'));
  const splitAt = accent === -1 ? Math.floor(assistant.length / 2) : accent + 1;
  process.stdout.write(assistant.subarray(0, splitAt), () => {
    fs.writeFileSync(marker('ready'), String(splitAt));
  });

  const timer = setInterval(() => {
    if (!fs.existsSync(marker('release'))) return;
    clearInterval(timer);
    process.stdout.write(assistant.subarray(splitAt));
    process.stdout.write('\n');
    line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 25,
      num_turns: 1,
      total_cost_usd: 0,
      modelUsage: {
        'fixture-v1': { inputTokens: Math.max(1, prompt.length), outputTokens: 4 },
      },
    });
  }, 25);
});
