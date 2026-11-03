'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderQueue } = require('../lib/queue-order');

test('une liste dupliquée ne peut pas remplacer et perdre un message de la file', () => {
  const queue = [{ id: 'a', text: 'premier' }, { id: 'b', text: 'à conserver' }];
  assert.throws(() => orderQueue(queue, ['a', 'a']), { statusCode: 400 });
  assert.deepEqual(queue.map((entry) => entry.id), ['a', 'b']);
  assert.deepEqual(orderQueue(queue, ['b', 'a']).map((entry) => entry.text), ['à conserver', 'premier']);
});

test('réordonner refuse les identifiants absents ou étrangers', () => {
  const queue = [{ id: 'a' }, { id: 'b' }];
  for (const ids of [['a'], ['a', 'c'], null, {}]) {
    assert.throws(() => orderQueue(queue, ids), { statusCode: 400 });
  }
});
