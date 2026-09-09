import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FORGOT_TASK_MESSAGES,
  START_GREEN_MESSAGES,
  START_NO_CI_MESSAGES,
  START_RED_MESSAGES,
  WAIT_FOOTER,
  WAIT_MESSAGES,
} from './messages.ts';
import {
  PRESENCE_ACK_NOTE,
  composePresenceSummary,
  descriptionMissesTaskLink,
  isPresenceAck,
  presenceAckResult,
} from './compose.ts';

void test('descriptionMissesTaskLink: description only, not a branch-shaped id', () => {
  assert.equal(descriptionMissesTaskLink(''), true);
  assert.equal(descriptionMissesTaskLink('please review'), true);
  assert.equal(descriptionMissesTaskLink('See https://kaiten.example.com/cards/4567'), false);
  assert.equal(descriptionMissesTaskLink('KAITEN-4567 in the body'), false);
  assert.equal(descriptionMissesTaskLink('Fixes #4567 today'), false);
});

void test('composePresenceSummary: wait includes footer; forgot-task is optional', () => {
  const wait = composePresenceSummary('wait', 'linked https://kaiten.example.com/cards/1', () => 0);
  assert.equal(wait.startsWith(WAIT_MESSAGES[0] ?? ''), true);
  assert.equal(wait.includes(WAIT_FOOTER), true);
  assert.equal(wait.includes('задач'), false);

  const waitForgot = composePresenceSummary('wait', 'no card here', () => 0);
  assert.equal(waitForgot.includes(WAIT_FOOTER), true);
  assert.equal(waitForgot.includes('задач') || waitForgot.includes('Kaiten'), true);

  const green = composePresenceSummary('green', 'https://kaiten.example.com/cards/9', () => 0);
  assert.equal(green.includes(WAIT_FOOTER), false);
  assert.equal(green.includes('@mira review'), false);
});

void test('presence pools: wait has 20 lines; others are non-empty', () => {
  assert.equal(WAIT_MESSAGES.length, 20);
  assert.ok(START_GREEN_MESSAGES.length >= 8);
  assert.ok(START_RED_MESSAGES.length >= 8);
  assert.ok(START_NO_CI_MESSAGES.length >= 8);
  assert.ok(FORGOT_TASK_MESSAGES.length >= 8);
});

void test('isPresenceAck: sentinel only', () => {
  assert.equal(isPresenceAck(presenceAckResult('hi', 'wait')), true);
  assert.equal(isPresenceAck({ verdict: 'ok', summary: 'hi', findings: [] }), false);
  assert.equal(PRESENCE_ACK_NOTE, 'presence-ack');
});
