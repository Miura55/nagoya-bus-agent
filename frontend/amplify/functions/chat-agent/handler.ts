import { randomUUID } from 'node:crypto'

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import { env } from '$amplify/env/chat-agent'

import type { Schema } from '../../data/resource'

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
  env as unknown as Parameters<typeof getAmplifyDataClientConfig>[0],
)
Amplify.configure(resourceConfig, libraryOptions)

const dataClient = generateClient<Schema>()

const agentClient = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1',
})

const INVOKE_TIMEOUT_MS = 1500000

export const handler = async (event: any) => {
  const fieldName = (event as { fieldName?: string }).fieldName

  if (fieldName === 'publishChunk') {
    const args = event.arguments as {
      sessionId?: string
      delta?: string | null
      done?: boolean
      error?: string | null
    }

    if (!args?.sessionId || typeof args.done !== 'boolean') {
      throw new Error('publishChunk requires sessionId and done.')
    }

    return {
      sessionId: args.sessionId,
      delta: args.delta ?? null,
      done: args.done,
      error: args.error ?? null,
    }
  }

  const prompt = event.arguments?.prompt?.trim()

  if (!prompt) {
    if (fieldName === 'healthCheck') {
      return {
        reply: 'ok',
        sessionId: randomUUID(),
        statusCode: 200,
      }
    }

    throw new Error('Prompt must not be empty.')
  }

  const runtimeSessionId = event.arguments.sessionId?.trim() || randomUUID()
  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN
  const runtimeUserId = extractRuntimeUserId(event.identity)

  if (!runtimeArn) {
    throw new Error('AGENTCORE_RUNTIME_ARN is not configured.')
  }

  const abortController = new AbortController()
  const abortTimer = setTimeout(() => {
    abortController.abort()
  }, INVOKE_TIMEOUT_MS)

  const response = await agentClient
    .send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: runtimeArn,
        contentType: 'application/json',
        accept: 'application/json',
        runtimeSessionId,
        runtimeUserId,
        payload: new TextEncoder().encode(JSON.stringify({ prompt })),
      }),
      { abortSignal: abortController.signal },
    )
    .catch((error: unknown) => {
      if (isAbortError(error)) {
        throw new Error('Agent runtime request timed out before completion.')
      }
      throw error
    })
    .finally(() => {
      clearTimeout(abortTimer)
    })

  // Consume the response body as a stream, publishing each text delta to
  // the AppSync subscription so the frontend can render progressively.
  const textChunks: string[] = []

  try {
    for await (const delta of streamResponseDeltas(response.response)) {
      textChunks.push(delta)
      await publishChunk(runtimeSessionId, delta, false).catch((err: unknown) => {
        console.warn('publishChunk (delta) failed:', err)
      })
    }
  } finally {
    // Always signal completion so listeners can clean up.
    await publishChunk(runtimeSessionId, undefined, true).catch((err: unknown) => {
      console.warn('publishChunk (done) failed:', err)
    })
  }

  const reply = textChunks.join('').trim()

  if (!reply) {
    throw new Error('The agent returned an empty response.')
  }

  return {
    reply,
    sessionId: response.runtimeSessionId ?? runtimeSessionId,
    traceId: response.traceId,
    statusCode: response.statusCode,
  }
}

// ---------------------------------------------------------------------------
// Response body streaming
// ---------------------------------------------------------------------------

type ResponseBodyLike =
  | {
    transformToString?: () => Promise<string>
    transformToByteArray?: () => Promise<Uint8Array>
  }
  | undefined

/**
 * Yields individual text deltas from the Bedrock AgentCore response body.
 *
 * In the Node.js Lambda runtime the body is a Readable stream that
 * implements AsyncIterable, so we iterate it chunk-by-chunk. As a fallback
 * for non-iterable bodies (e.g. Blob) we read the whole body at once.
 */
async function* streamResponseDeltas(body: ResponseBodyLike): AsyncGenerator<string> {
  if (!body) return

  if (Symbol.asyncIterator in (body as object)) {
    const stream = body as unknown as AsyncIterable<Uint8Array>
    const decoder = new TextDecoder()
    let lineBuffer = ''

    for await (const chunk of stream) {
      lineBuffer += decoder.decode(chunk, { stream: true })
      const lines = lineBuffer.split('\n')
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        yield* parseLine(line)
      }
    }

    // Flush the TextDecoder and process any remaining buffered line.
    lineBuffer += decoder.decode()
    if (lineBuffer.trim()) {
      yield* parseLine(lineBuffer)
    }
    return
  }

  // Fallback: read the body all at once then extract deltas.
  let raw = ''
  if (typeof (body as { transformToString?: () => Promise<string> }).transformToString === 'function') {
    raw = await (body as { transformToString: () => Promise<string> }).transformToString()
  } else if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray()
    raw = new TextDecoder().decode(bytes)
  }

  const parsed = parseStructuredPayload(raw)
  for (const text of extractContentBlockDeltaTexts(parsed)) {
    yield text
  }
}

/** Parse one newline-delimited SSE / JSON line and yield any text deltas. */
function* parseLine(line: string): Generator<string> {
  const trimmed = line.trim()
  if (!trimmed) return

  const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    return
  }

  for (const text of extractContentBlockDeltaTexts(parsed)) {
    yield text
  }
}

// ---------------------------------------------------------------------------
// Chunk publishing through Amplify Data client
// ---------------------------------------------------------------------------

async function publishChunk(
  sessionId: string,
  delta: string | undefined,
  done: boolean,
): Promise<void> {
  const result = await dataClient.mutations.publishChunk({
    sessionId,
    delta: delta ?? null,
    done,
  })

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const detail = result.errors
      .map((entry) => entry?.message)
      .filter(Boolean)
      .join(' / ')
    throw new Error(detail || 'publishChunk failed.')
  }
}

// ---------------------------------------------------------------------------
// Payload parsing helpers (unchanged from original)
// ---------------------------------------------------------------------------

function isAbortError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const name = 'name' in error ? error.name : undefined
  const message = 'message' in error ? String(error.message) : ''

  return name === 'AbortError' || /aborted|abort/i.test(message)
}

function parseStructuredPayload(payload: string) {
  const normalized = payload.trim()
  if (!normalized) return payload

  try {
    return JSON.parse(normalized)
  } catch {
    const lines = normalized
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim()
        return trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
      })
      .filter(Boolean)

    if (lines.length === 0) return payload

    const parsedLines: unknown[] = []
    for (const line of lines) {
      try {
        parsedLines.push(JSON.parse(line))
      } catch {
        return payload
      }
    }

    return parsedLines
  }
}

function extractContentBlockDeltaTexts(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => extractContentBlockDeltaTexts(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const record = value as Record<string, unknown>
  const collected: string[] = []

  const contentBlockDelta = record.contentBlockDelta
  if (contentBlockDelta && typeof contentBlockDelta === 'object') {
    const delta = (contentBlockDelta as Record<string, unknown>).delta
    if (delta && typeof delta === 'object') {
      const text = (delta as Record<string, unknown>).text
      if (typeof text === 'string') {
        collected.push(text)
      }
    }
  }

  for (const nestedValue of Object.values(record)) {
    if (!nestedValue || typeof nestedValue !== 'object') {
      continue
    }
    collected.push(...extractContentBlockDeltaTexts(nestedValue))
  }

  return collected
}

function extractRuntimeUserId(identity: unknown) {
  if (!identity || typeof identity !== 'object') {
    return undefined
  }

  if ('sub' in identity && typeof identity.sub === 'string') {
    return identity.sub
  }

  if ('username' in identity && typeof identity.username === 'string') {
    return identity.username
  }

  return undefined
}

