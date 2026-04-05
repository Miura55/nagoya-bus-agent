import { randomUUID } from 'node:crypto'

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import { getAmplifyDataClientConfig } from '@aws-amplify/backend/function/runtime'
import { Amplify } from 'aws-amplify'
import { generateClient } from 'aws-amplify/data'
import { env } from '$amplify/env/chat-agent'

import type { Schema } from '../../data/resource'

// ---------------------------------------------------------------------------
// Module-level initialization
// ---------------------------------------------------------------------------

const { resourceConfig, libraryOptions } = await getAmplifyDataClientConfig(
  env as unknown as Parameters<typeof getAmplifyDataClientConfig>[0],
)
Amplify.configure(resourceConfig, libraryOptions)

const dataClient = generateClient<Schema>()

const agentClient = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1',
})

const lambdaClient = new LambdaClient({
  region: process.env.AWS_REGION ?? 'ap-northeast-1',
})

const INVOKE_TIMEOUT_MS = 1_500_000
const ASYNC_TASK_NAME = 'chat-stream-v1'

type ChatEvent = {
  fieldName?: string
  identity?: unknown
  arguments?: {
    prompt?: string
    sessionId?: string
    delta?: string | null
    done?: boolean
    error?: string | null
  }
}

type AsyncChatTaskEvent = {
  task: typeof ASYNC_TASK_NAME
  prompt: string
  sessionId: string
  runtimeUserId?: string
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (event: unknown) => {
  if (isAsyncChatTaskEvent(event)) {
    await runAsyncChatTask(event)
    return { accepted: true }
  }

  const chatEvent = event as ChatEvent
  const fieldName = chatEvent.fieldName

  // AppSync resolver passthrough: Lambda is set as the resolver for
  // publishChunk so that the mutation triggers onChatChunk subscriptions.
  // Simply echo the arguments back as the resolver result.
  if (fieldName === 'publishChunk') {
    const { sessionId, delta = null, done, error = null } = chatEvent.arguments as {
      sessionId: string
      delta?: string | null
      done: boolean
      error?: string | null
    }
    return { sessionId, delta, done, error }
  }

  if (fieldName === 'healthCheck') {
    return { reply: 'ok', sessionId: randomUUID(), statusCode: 200 }
  }

  if (fieldName !== 'chat') {
    throw new Error(`Unsupported fieldName: ${String(fieldName)}`)
  }

  const prompt = chatEvent.arguments?.prompt?.trim()
  if (!prompt) {
    throw new Error('Prompt must not be empty.')
  }

  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN
  if (!runtimeArn) {
    throw new Error('AGENTCORE_RUNTIME_ARN is not configured.')
  }

  const runtimeSessionId = chatEvent.arguments?.sessionId?.trim() || randomUUID()
  const runtimeUserId = extractRuntimeUserId(chatEvent.identity)

  await enqueueAsyncChatTask({
    task: ASYNC_TASK_NAME,
    prompt,
    sessionId: runtimeSessionId,
    runtimeUserId,
  })

  return {
    reply: '処理を開始しました。回答を順次配信します。',
    sessionId: runtimeSessionId,
    statusCode: 202,
  }
}

async function enqueueAsyncChatTask(taskEvent: AsyncChatTaskEvent): Promise<void> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME
  if (!functionName) {
    throw new Error('AWS_LAMBDA_FUNCTION_NAME is not configured.')
  }

  await lambdaClient.send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(taskEvent)),
    }),
  )
}

async function runAsyncChatTask(taskEvent: AsyncChatTaskEvent): Promise<void> {
  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN
  if (!runtimeArn) {
    await publishChunk(taskEvent.sessionId, undefined, true, 'AGENTCORE_RUNTIME_ARN is not configured.').catch(
      (err: unknown) => console.warn('publishChunk (missing runtime arn) failed:', err),
    )
    return
  }

  // Invoke the AgentCore runtime with a hard timeout.
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(), INVOKE_TIMEOUT_MS)
  let donePublished = false

  try {
    const response = await agentClient
      .send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          contentType: 'application/json',
          accept: 'application/json',
          runtimeSessionId: taskEvent.sessionId,
          runtimeUserId: taskEvent.runtimeUserId,
          payload: new TextEncoder().encode(JSON.stringify({ prompt: taskEvent.prompt })),
        }),
        { abortSignal: abortController.signal },
      )
      .catch((error: unknown) => {
        if (isAbortError(error)) {
          throw new Error('Agent runtime request timed out before completion.')
        }
        throw error
      })
      .finally(() => clearTimeout(abortTimer))

    // Stream the response body, publishing each text delta to AppSync so the
    // frontend can render progressively.
    const textChunks: string[] = []

    try {
      for await (const delta of streamResponseDeltas(response.response)) {
        textChunks.push(delta)
        await publishChunk(taskEvent.sessionId, delta, false).catch((err: unknown) => {
          console.warn('publishChunk (delta) failed:', err)
        })
      }
    } finally {
      // Always publish the terminal done=true event so subscribers can clean up.
      await publishChunk(taskEvent.sessionId, undefined, true).catch((err: unknown) => {
        console.warn('publishChunk (done) failed:', err)
      })
      donePublished = true
    }

    const reply = textChunks.join('').trim()
    if (!reply) {
      console.warn('Async chat task completed but produced empty reply.', {
        sessionId: taskEvent.sessionId,
      })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chat stream failed.'
    console.error('Async chat task failed:', error)
    if (!donePublished) {
      await publishChunk(taskEvent.sessionId, undefined, true, message).catch((err: unknown) => {
        console.warn('publishChunk (error done) failed:', err)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// AgentCore response streaming
// ---------------------------------------------------------------------------

type ResponseBody =
  | {
      transformToString?: () => Promise<string>
      transformToByteArray?: () => Promise<Uint8Array>
    }
  | undefined

/** Yields individual text deltas from the Bedrock AgentCore response body. */
async function* streamResponseDeltas(body: ResponseBody): AsyncGenerator<string> {
  if (!body) return

  // Node.js Lambda runtime: body is a Readable that implements AsyncIterable.
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

    // Flush remaining bytes from the TextDecoder.
    lineBuffer += decoder.decode()
    if (lineBuffer.trim()) yield* parseLine(lineBuffer)
    return
  }

  // Fallback: read the body all at once.
  let raw = ''
  if (typeof (body as { transformToString?(): Promise<string> }).transformToString === 'function') {
    raw = await (body as { transformToString(): Promise<string> }).transformToString()
  } else if (typeof (body as { transformToByteArray?(): Promise<Uint8Array> }).transformToByteArray === 'function') {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray()
    raw = new TextDecoder().decode(bytes)
  }

  for (const text of extractContentBlockDeltaTexts(parseStructuredPayload(raw))) {
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

  yield* extractContentBlockDeltaTexts(parsed)
}

// ---------------------------------------------------------------------------
// Chunk publishing
// ---------------------------------------------------------------------------

async function publishChunk(
  sessionId: string,
  delta: string | undefined,
  done: boolean,
  error?: string,
): Promise<void> {
  const result = await dataClient.mutations.publishChunk({
    sessionId,
    delta: delta ?? null,
    done,
    error: error ?? null,
  })

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const detail = result.errors.map((e) => e?.message).filter(Boolean).join(' / ')
    throw new Error(detail || 'publishChunk failed.')
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const name = 'name' in error ? error.name : undefined
  const message = 'message' in error ? String(error.message) : ''
  return name === 'AbortError' || /aborted|abort/i.test(message)
}

/**
 * Parses a raw payload string into a JSON value or array of JSON values.
 * Returns the original string if parsing fails completely.
 */
function parseStructuredPayload(payload: string): unknown {
  const normalized = payload.trim()
  if (!normalized) return normalized

  try {
    return JSON.parse(normalized)
  } catch {
    const lines = normalized
      .split(/\r?\n/)
      .map((l) => (l.trim().startsWith('data:') ? l.trim().slice(5).trim() : l.trim()))
      .filter(Boolean)

    if (lines.length === 0) return normalized

    const parsed: unknown[] = []
    for (const line of lines) {
      try {
        parsed.push(JSON.parse(line))
      } catch {
        return normalized
      }
    }
    return parsed
  }
}

/**
 * Recursively extracts text strings from Bedrock contentBlockDelta events.
 * Structure: { contentBlockDelta: { delta: { text: string } } }
 */
function extractContentBlockDeltaTexts(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(extractContentBlockDeltaTexts)
  }
  if (!value || typeof value !== 'object') return []

  const record = value as Record<string, unknown>

  // Direct hit: this object is a contentBlockDelta event.
  const cbd = record.contentBlockDelta
  if (cbd && typeof cbd === 'object') {
    const delta = (cbd as Record<string, unknown>).delta
    if (delta && typeof delta === 'object') {
      const text = (delta as Record<string, unknown>).text
      if (typeof text === 'string') return [text]
    }
  }

  // Recurse into nested objects.
  return Object.values(record)
    .filter((v): v is object => !!v && typeof v === 'object')
    .flatMap(extractContentBlockDeltaTexts)
}

function extractRuntimeUserId(identity: unknown): string | undefined {
  if (!identity || typeof identity !== 'object') return undefined
  if ('sub' in identity && typeof identity.sub === 'string') return identity.sub
  if ('username' in identity && typeof identity.username === 'string') return identity.username
  return undefined
}

function isAsyncChatTaskEvent(value: unknown): value is AsyncChatTaskEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.task === ASYNC_TASK_NAME
    && typeof record.prompt === 'string'
    && typeof record.sessionId === 'string'
    && (typeof record.runtimeUserId === 'string' || typeof record.runtimeUserId === 'undefined')
  )
}


