import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWatchlist } from './watchlist.ts';

test('a stored watchlist parses to unique positive integer ids', () => {
  assert.deepEqual(parseWatchlist('[3, 1, 3, "x", -2, 1.5, 7]'), [3, 1, 7]);
});

test('anything that is not a list reads as empty, never as a crash', () => {
  for (const raw of [null, '', 'not json', '{"a":1}', '42']) {
    assert.deepEqual(parseWatchlist(raw), []);
  }
});

test('a corrupted, enormous list is capped', () => {
  const big = JSON.stringify(Array.from({ length: 2000 }, (_, i) => i + 1));
  assert.equal(parseWatchlist(big).length, 500);
});
