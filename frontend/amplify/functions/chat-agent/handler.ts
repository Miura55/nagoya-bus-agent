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
      for await (const eventText of streamResponseEvents(response.response)) {
        if (!eventText) {
          continue
        }

        textChunks.push(eventText)

        await publishChunk(taskEvent.sessionId, eventText, false).catch((err: unknown) => {
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

/** Yields raw stream event lines from the Bedrock AgentCore response body. */
async function* streamResponseEvents(body: ResponseBody): AsyncGenerator<string> {
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

  for (const line of raw.split(/\r?\n/)) {
    yield* parseLine(line)
  }
}

/** Parse one newline-delimited SSE / JSON line and convert it to display text. */
function* parseLine(line: string): Generator<string> {
  const trimmed = line.trim()
  if (!trimmed) return

  const text = extractEventText(trimmed)
  if (text) {
    yield text
  }
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

function extractEventText(rawLine: string): string {
  const normalized = rawLine.startsWith('data:') ? rawLine.slice(5).trim() : rawLine
  if (!normalized || normalized === '[DONE]') {
    return ''
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    return ''
  }

  if (!parsed || typeof parsed !== 'object') {
    return ''
  }

  const eventRecord = parsed as Record<string, unknown>

  if ('event' in eventRecord && eventRecord.event && typeof eventRecord.event === 'object') {
    const eventData = eventRecord.event as Record<string, unknown>

    // Detect tool use start event
    if ('contentBlockStart' in eventData && eventData.contentBlockStart && typeof eventData.contentBlockStart === 'object') {
      const contentBlockStart = eventData.contentBlockStart as Record<string, unknown>
      const start = contentBlockStart.start
      if (start && typeof start === 'object') {
        const toolUse = (start as Record<string, unknown>).toolUse
        if (toolUse && typeof toolUse === 'object') {
          const toolName = (toolUse as Record<string, unknown>).name
          if (typeof toolName === 'string') {
            return `\n\n\`\`\`\n⚒️ Using tool: ${toolName}\n\`\`\`\n\n`
          }
        }
      }
    }

    if ('contentBlockDelta' in eventData && eventData.contentBlockDelta && typeof eventData.contentBlockDelta === 'object') {
      const contentBlockDelta = eventData.contentBlockDelta as Record<string, unknown>
      const delta = contentBlockDelta.delta
      if (delta && typeof delta === 'object') {
        const text = (delta as Record<string, unknown>).text
        if (typeof text === 'string') {
          return text
        }
      }
    }

    if (typeof eventData.text === 'string') {
      return eventData.text
    }
  }

  return ''
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


