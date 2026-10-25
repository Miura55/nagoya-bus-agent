import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrderedChunkConsumer } from './ordered-chunk-consumer.js'

test('out-of-order Markdown chunks are applied in sequence order', () => {
  const applied = []
  const consumer = createOrderedChunkConsumer((chunk) => applied.push(chunk))

  consumer.push({ sequence: 2, delta: '**', done: false })
  consumer.push({ sequence: 1, delta: 'bold', done: false })
  consumer.push({ sequence: 3, delta: null, done: true })
  assert.deepEqual(applied, [])

  consumer.push({ sequence: 0, delta: '**', done: false })

  assert.equal(applied.map((chunk) => chunk.delta ?? '').join(''), '**bold**')
  assert.equal(applied.at(-1).done, true)
})

test('duplicate and post-terminal chunks are ignored', () => {
  const applied = []
  const consumer = createOrderedChunkConsumer((chunk) => applied.push(chunk))

  consumer.push({ sequence: 0, delta: 'A', done: false })
  consumer.push({ sequence: 0, delta: 'A', done: false })
  consumer.push({ sequence: 1, delta: null, done: true })
  consumer.push({ sequence: 2, delta: 'B', done: false })

  assert.deepEqual(applied, [
    { sequence: 0, delta: 'A', done: false },
    { sequence: 1, delta: null, done: true },
  ])
})
