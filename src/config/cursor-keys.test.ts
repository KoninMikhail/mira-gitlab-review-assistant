/**
 * Unit tests for Cursor API key pool parsing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCursorApiKeys, serializeCursorApiKeys } from './cursor-keys.ts';

void test('parseCursorApiKeys splits comma, semicolon, and newlines', () => {
  assert.deepEqual(parseCursorApiKeys('key_a, key_b;key_c\nkey_d'), [
    'key_a',
    'key_b',
    'key_c',
    'key_d',
  ]);
});

void test('parseCursorApiKeys drops blanks and duplicates, keeps first order', () => {
  assert.deepEqual(parseCursorApiKeys('  key_a, ,key_a, key_b  '), ['key_a', 'key_b']);
  assert.deepEqual(parseCursorApiKeys('   '), []);
});

void test('parseCursorApiKeys keeps a single key unchanged', () => {
  assert.deepEqual(parseCursorApiKeys('key_only'), ['key_only']);
});

void test('serializeCursorApiKeys joins unique trimmed keys', () => {
  assert.equal(serializeCursorApiKeys([' key_a ', 'key_b', 'key_a']), 'key_a,key_b');
});
