import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createSessionTitle,
  normalizeStoredMessages,
  sortSessionsByRecent,
} from './chat-history.js'

test('sessions are sorted by most recent message without mutating input', () => {
  const sessions = [
    { id: 'old', lastMessageAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', lastMessageAt: '2026-02-01T00:00:00.000Z' },
  ]

  assert.deepEqual(sortSessionsByRecent(sessions).map((session) => session.id), ['new', 'old'])
  assert.deepEqual(sessions.map((session) => session.id), ['old', 'new'])
})

test('stored messages are de-duplicated and restored in turn order', () => {
  const messages = [
    { id: 'answer', role: 'assistant', content: 'A', orderKey: 'time#1#request' },
    { id: 'question', role: 'user', content: 'Q', orderKey: 'time#0#request' },
    { id: 'answer', role: 'assistant', content: 'A', orderKey: 'time#1#request' },
  ]

  assert.deepEqual(normalizeStoredMessages(messages), [
    { id: 'question', role: 'user', text: 'Q' },
    { id: 'answer', role: 'assistant', text: 'A' },
  ])
})

test('session titles are normalized and truncated', () => {
  assert.equal(createSessionTitle('  栄から\n 名古屋駅へ  '), '栄から 名古屋駅へ')
  assert.equal(createSessionTitle('あ'.repeat(41)), `${'あ'.repeat(40)}…`)
})
