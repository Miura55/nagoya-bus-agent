/**
 * Applies stream chunks exactly once in sequence order.
 *
 * AppSync delivers subscription events asynchronously, so mutation order must
 * not be treated as delivery order. A terminal event is also held until all
 * preceding deltas have arrived.
 */
export function createOrderedChunkConsumer(onChunk) {
  let nextSequence = 0
  let completed = false
  const pending = new Map()

  return {
    push(chunk) {
      const sequence = chunk?.sequence
      if (completed || !Number.isInteger(sequence) || sequence < nextSequence) {
        return
      }

      if (!pending.has(sequence)) {
        pending.set(sequence, chunk)
      }

      while (pending.has(nextSequence)) {
        const nextChunk = pending.get(nextSequence)
        pending.delete(nextSequence)
        nextSequence += 1
        onChunk(nextChunk)

        if (nextChunk.done) {
          completed = true
          pending.clear()
          break
        }
      }
    },
  }
}
