import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createHistoryLoadGuard,
  createSessionTitle,
  normalizeStoredMessages,
  sortSessionsByRecent,
} from './chat-history.js'

test('only the latest history load may update the workspace', () => {
  const guard = createHistoryLoadGuard()
  const first = guard.start()
  const second = guard.start()

  assert.equal(guard.isCurrent(first), false)
  assert.equal(guard.isCurrent(second), true)

  guard.invalidate()
  assert.equal(guard.isCurrent(second), false)
})

test('sessions are sorted by most recent message without mutating input', () => {
  const sessions = [
    { id: 'old', lastMessageAt: '2026-01-01T00:00:00.000Z' },
    { id: 'new', lastMessageAt: '2026-02-01T00:00:00.000Z' },
  ]

  assert.deepEqual(sortSessionsByRecent(sessions).map((session) => session.id), ['new', 'old'])
  assert.deepEqual(sessions.map((session) => session.id), ['old', 'new'])
})

test('stored messages are de-duplicated and restored in turn order', () => {
  const timestamp = '2026-11-01T05:30:00.000Z'
  const messages = [
    { id: 'answer', role: 'assistant', content: 'A', orderKey: `${timestamp}#1#request` },
    { id: 'question', role: 'user', content: 'Q', orderKey: `${timestamp}#0#request` },
    { id: 'answer', role: 'assistant', content: 'A', orderKey: `${timestamp}#1#request` },
  ]

  assert.deepEqual(normalizeStoredMessages(messages), [
    { id: 'question', role: 'user', text: 'Q', timestamp, status: 'complete', error: '' },
    { id: 'answer', role: 'assistant', text: 'A', timestamp, status: 'complete', error: '' },
  ])
})

test('failed partial responses retain their incomplete state and error', () => {
  const timestamp = '2026-11-01T05:30:00.000Z'
  const messages = [{
    id: 'partial-answer',
    role: 'assistant',
    content: '途中までの回答',
    status: 'failed',
    error: 'Agent runtime request timed out before completion.',
    orderKey: `${timestamp}#1#request`,
  }]

  assert.deepEqual(normalizeStoredMessages(messages), [{
    id: 'partial-answer',
    role: 'assistant',
    text: '途中までの回答',
    timestamp,
    status: 'failed',
    error: 'Agent runtime request timed out before completion.',
  }])
})

test('session titles are normalized and truncated', () => {
  assert.equal(createSessionTitle('  栄から\n 名古屋駅へ  '), '栄から 名古屋駅へ')
  assert.equal(createSessionTitle('あ'.repeat(41)), `${'あ'.repeat(40)}…`)
})
