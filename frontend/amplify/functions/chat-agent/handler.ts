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
const CHAT_TASK_NAME = 'chat-stream-v1'
const RESET_TASK_NAME = 'chat-reset-v1'

type ChatEvent = {
  fieldName?: string
  identity?: unknown
  arguments?: {
    prompt?: string
    sessionId?: string
    requestId?: string
    sequence?: number
    delta?: string | null
    done?: boolean
    error?: string | null
  }
}

type AsyncChatTaskEvent = {
  task: typeof CHAT_TASK_NAME
  prompt: string
  sessionId: string
  requestId: string
  runtimeUserId: string
  startedAt: string
  sessionGeneration: number
}

type AsyncResetTaskEvent = {
  task: typeof RESET_TASK_NAME
  sessionId: string
  runtimeUserId: string
  sessionGeneration: number
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

export const handler = async (event: unknown) => {
  if (isAsyncChatTaskEvent(event)) {
    await runAsyncChatTask(event)
    return { accepted: true }
  }
  if (isAsyncResetTaskEvent(event)) {
    await runAsyncResetTask(event)
    return { accepted: true }
  }

  const chatEvent = event as ChatEvent
  const fieldName = chatEvent.fieldName

  // AppSync resolver passthrough: Lambda is set as the resolver for
  // publishChunk so that the mutation triggers onChatChunk subscriptions.
  // Simply echo the arguments back as the resolver result.
  if (fieldName === 'publishChunk') {
    const { sessionId, requestId, sequence, delta = null, done, error = null } = chatEvent.arguments as {
      sessionId: string
      requestId: string
      sequence: number
      delta?: string | null
      done: boolean
      error?: string | null
    }
    return { sessionId, requestId, sequence, delta, done, error }
  }

  if (fieldName === 'healthCheck') {
    return { reply: 'ok', sessionId: randomUUID(), statusCode: 200 }
  }

  if (fieldName === 'resetConversation') {
    const sessionId = chatEvent.arguments?.sessionId?.trim()
    const runtimeUserId = extractRuntimeUserId(chatEvent.identity)
    if (!sessionId) {
      throw new Error('Session id must not be empty.')
    }
    if (!runtimeUserId) {
      throw new Error('Authenticated user id is not available.')
    }

    const sessionGeneration = await markConversationReset(sessionId, runtimeUserId)
    if (sessionGeneration !== undefined) {
      await enqueueAsyncTaskWithRetry({
        task: RESET_TASK_NAME,
        sessionId,
        runtimeUserId,
        sessionGeneration,
      })
    }
    return { sessionId, success: true }
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
  const requestId = chatEvent.arguments?.requestId?.trim() || randomUUID()
  const runtimeUserId = extractRuntimeUserId(chatEvent.identity)
  if (!runtimeUserId) {
    throw new Error('Authenticated user id is not available.')
  }
  const startedAt = new Date().toISOString()

  await retryPendingConversationCleanups(runtimeUserId)

  const sessionGeneration = await ensureOwnedSession(runtimeSessionId, runtimeUserId, prompt, startedAt)
  await persistMessage({
    owner: runtimeUserId,
    sessionId: runtimeSessionId,
    requestId,
    role: 'user',
    content: prompt,
    status: 'complete',
    sessionGeneration,
    orderKey: `${startedAt}#0#${requestId}`,
  })

  if (!await isCurrentSession(runtimeSessionId, runtimeUserId, sessionGeneration)) {
    await deletePersistedMessage(requestId, 'user')
    throw new Error('The conversation was reset before the message could be sent.')
  }

  const taskEvent: AsyncChatTaskEvent = {
    task: CHAT_TASK_NAME,
    prompt,
    sessionId: runtimeSessionId,
    requestId,
    runtimeUserId,
    startedAt,
    sessionGeneration,
  }
  try {
    await enqueueAsyncTask(taskEvent)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Starting the chat task failed.'
    await persistAssistantMessageIfCurrent(
      taskEvent,
      '回答処理を開始できませんでした。',
      'failed',
      message,
    ).catch((persistError: unknown) => {
      console.warn('Persisting chat start failure failed:', persistError)
    })
    throw error
  }

  return {
    reply: '処理を開始しました。回答を順次配信します。',
    sessionId: runtimeSessionId,
    requestId,
    statusCode: 202,
  }
}

async function enqueueAsyncTask(taskEvent: AsyncChatTaskEvent | AsyncResetTaskEvent): Promise<void> {
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

async function enqueueAsyncTaskWithRetry(
  taskEvent: AsyncChatTaskEvent | AsyncResetTaskEvent,
): Promise<void> {
  const retryDelaysMs = [0, 100, 300]
  let lastError: unknown
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    try {
      await enqueueAsyncTask(taskEvent)
      return
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

async function retryPendingConversationCleanups(owner: string): Promise<void> {
  const pendingTasks: AsyncResetTaskEvent[] = []
  let nextToken: string | null | undefined
  do {
    const result = await dataClient.models.ChatSession.listChatSessionsByOwner(
      { owner },
      {
        filter: {
          status: { eq: 'reset' },
          cleanupStatus: { ne: 'complete' },
        },
        limit: 100,
        nextToken,
      },
    )
    assertNoDataErrors(result.errors, 'Loading pending conversation cleanups failed.')
    for (const session of result.data ?? []) {
      pendingTasks.push({
        task: RESET_TASK_NAME,
        sessionId: session.id,
        runtimeUserId: owner,
        sessionGeneration: normalizeSessionGeneration(session.generation),
      })
    }
    nextToken = result.nextToken
  } while (nextToken)

  await Promise.all(pendingTasks.map((task) =>
    enqueueAsyncTaskWithRetry(task).catch((error: unknown) => {
      console.warn('Retrying pending conversation cleanup failed:', {
        sessionId: task.sessionId,
        error,
      })
    }),
  ))
}

async function runAsyncChatTask(taskEvent: AsyncChatTaskEvent): Promise<void> {
  let nextSequence = 0
  let donePublished = false
  const textChunks: string[] = []
  if (!await isCurrentSession(
    taskEvent.sessionId,
    taskEvent.runtimeUserId,
    taskEvent.sessionGeneration,
  )) {
    await publishChunkWithRetry(
      taskEvent,
      nextSequence,
      undefined,
      true,
      'この会話はリセットされました。',
    ).catch((error: unknown) => console.warn('publishChunk (reset session) failed:', error))
    return
  }

  const runtimeArn = process.env.AGENTCORE_RUNTIME_ARN
  if (!runtimeArn) {
    await publishChunkWithRetry(taskEvent, nextSequence, undefined, true, 'AGENTCORE_RUNTIME_ARN is not configured.').catch(
      (err: unknown) => console.warn('publishChunk (missing runtime arn) failed:', err),
    )
    return
  }

  // Invoke the AgentCore runtime with a hard timeout.
  const abortController = new AbortController()
  const abortTimer = setTimeout(() => abortController.abort(), INVOKE_TIMEOUT_MS)

  try {
    const response = await agentClient
      .send(
        new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          contentType: 'application/json',
          accept: 'application/json',
          runtimeSessionId: taskEvent.sessionId,
          runtimeUserId: taskEvent.runtimeUserId,
          payload: new TextEncoder().encode(
            JSON.stringify({
              prompt: taskEvent.prompt,
              // Cognito sub separates memory by user, while runtimeSessionId
              // separates that user's individual conversations.
              actor_id: taskEvent.runtimeUserId,
            }),
          ),
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
    for await (const eventText of streamResponseEvents(response.response)) {
      if (!eventText) {
        continue
      }

      textChunks.push(eventText)

      // A retry may deliver the same sequence more than once if the mutation
      // succeeded but its response was lost. The frontend de-duplicates it.
      await publishChunkWithRetry(taskEvent, nextSequence, eventText, false)
      nextSequence += 1
    }

    const reply = textChunks.join('').trim()
    if (reply) {
      // Store the complete answer before publishing the terminal event. Once
      // the UI sees done=true, a reload can therefore restore this response.
      const persisted = await persistAssistantMessageIfCurrent(taskEvent, reply, 'complete')
      if (!persisted) {
        await publishChunkWithRetry(
          taskEvent,
          nextSequence,
          undefined,
          true,
          'この会話はリセットされました。',
        )
        donePublished = true
        return
      }
    } else {
      console.warn('Async chat task completed but produced empty reply.', {
        sessionId: taskEvent.sessionId,
      })
    }

    // The terminal event is sequenced after every delta. The subscriber waits
    // for any earlier delayed events before applying it.
    await publishChunkWithRetry(taskEvent, nextSequence, undefined, true)
    donePublished = true
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Chat stream failed.'
    console.error('Async chat task failed:', error)
    const partialReply = textChunks.join('').trim()
    await persistAssistantMessageIfCurrent(
      taskEvent,
      partialReply || '回答を取得できませんでした。',
      'failed',
      message,
    ).catch((persistError: unknown) => {
      console.warn('Persisting failed assistant response failed:', persistError)
    })
    if (!donePublished) {
      await publishChunkWithRetry(taskEvent, nextSequence, undefined, true, message).catch((err: unknown) => {
        console.warn('publishChunk (error done) failed:', err)
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------

type PersistedMessage = {
  owner: string
  sessionId: string
  requestId: string
  role: 'user' | 'assistant'
  content: string
  status: 'complete' | 'failed'
  error?: string
  sessionGeneration: number
  orderKey: string
}

async function ensureOwnedSession(
  sessionId: string,
  owner: string,
  firstPrompt: string,
  now: string,
): Promise<number> {
  const existing = await dataClient.models.ChatSession.get({ id: sessionId })
  assertNoDataErrors(existing.errors, 'Loading chat session failed.')

  if (existing.data) {
    if (existing.data.owner !== owner) {
      throw new Error('The requested chat session does not belong to this user.')
    }
    if (existing.data.status === 'reset') {
      throw new Error('The requested chat session has been reset.')
    }
    const generation = normalizeSessionGeneration(existing.data.generation)
    const touched = await dataClient.models.ChatSession.update({
      id: sessionId,
      lastMessageAt: now,
    })
    assertNoDataErrors(touched.errors, 'Updating chat session failed.')
    return generation
  }

  const generation = 1
  const created = await dataClient.models.ChatSession.create({
    id: sessionId,
    owner,
    title: createSessionTitle(firstPrompt),
    lastMessageAt: now,
    status: 'active',
    generation,
  })

  if (created.errors?.length) {
    // A concurrent first message may have created the same session. Re-read it
    // and still enforce ownership rather than accepting the conflict blindly.
    const raced = await dataClient.models.ChatSession.get({ id: sessionId })
    assertNoDataErrors(raced.errors, 'Loading concurrently created chat session failed.')
    if (!raced.data || raced.data.owner !== owner || raced.data.status === 'reset') {
      assertNoDataErrors(created.errors, 'Creating chat session failed.')
      throw new Error('Creating chat session failed.')
    }
    return normalizeSessionGeneration(raced.data.generation)
  }

  return generation
}

async function touchSessionIfCurrent(
  sessionId: string,
  owner: string,
  generation: number,
  now = new Date().toISOString(),
): Promise<boolean> {
  if (!await isCurrentSession(sessionId, owner, generation)) return false
  const result = await dataClient.models.ChatSession.update({
    id: sessionId,
    lastMessageAt: now,
  })
  assertNoDataErrors(result.errors, 'Updating chat session failed.')
  return true
}

async function persistMessage(message: PersistedMessage): Promise<void> {
  const id = `${message.requestId}-${message.role}`
  const result = await dataClient.models.ChatMessage.create({ id, ...message })
  if (!result.errors?.length) return

  // Lambda Event invocations can be retried. Deterministic ids make storing a
  // repeated task idempotent while this check prevents accepting a collision.
  const existing = await dataClient.models.ChatMessage.get({ id })
  assertNoDataErrors(existing.errors, 'Loading persisted chat message failed.')
  if (
    existing.data?.owner === message.owner
    && existing.data.sessionId === message.sessionId
    && existing.data.requestId === message.requestId
    && existing.data.role === message.role
    && existing.data.sessionGeneration === message.sessionGeneration
  ) {
    if (
      existing.data.status !== message.status
      || existing.data.content !== message.content
      || (existing.data.error ?? undefined) !== message.error
    ) {
      const updated = await dataClient.models.ChatMessage.update({
        id,
        content: message.content,
        status: message.status,
        error: message.error ?? null,
        orderKey: message.orderKey,
      })
      assertNoDataErrors(updated.errors, 'Updating persisted chat message failed.')
    }
    return
  }
  assertNoDataErrors(result.errors, 'Persisting chat message failed.')
  throw new Error('Persisting chat message failed.')
}

async function persistAssistantMessageIfCurrent(
  taskEvent: AsyncChatTaskEvent,
  content: string,
  status: 'complete' | 'failed',
  error?: string,
): Promise<boolean> {
  if (!await isCurrentSession(
    taskEvent.sessionId,
    taskEvent.runtimeUserId,
    taskEvent.sessionGeneration,
  )) return false

  await persistMessage({
    owner: taskEvent.runtimeUserId,
    sessionId: taskEvent.sessionId,
    requestId: taskEvent.requestId,
    role: 'assistant',
    content,
    status,
    error,
    sessionGeneration: taskEvent.sessionGeneration,
    orderKey: `${taskEvent.startedAt}#1#${taskEvent.requestId}`,
  })

  // This second check closes the window where reset happens after the first
  // check but before the write. In that ordering, remove our own late write.
  if (!await isCurrentSession(
    taskEvent.sessionId,
    taskEvent.runtimeUserId,
    taskEvent.sessionGeneration,
  )) {
    await deletePersistedMessage(taskEvent.requestId, 'assistant')
    return false
  }

  return touchSessionIfCurrent(
    taskEvent.sessionId,
    taskEvent.runtimeUserId,
    taskEvent.sessionGeneration,
  )
}

async function isCurrentSession(
  sessionId: string,
  owner: string,
  generation: number,
): Promise<boolean> {
  const result = await dataClient.models.ChatSession.get({ id: sessionId })
  assertNoDataErrors(result.errors, 'Loading chat session state failed.')
  return Boolean(
    result.data
    && result.data.owner === owner
    && result.data.status !== 'reset'
    && normalizeSessionGeneration(result.data.generation) === generation,
  )
}

async function markConversationReset(sessionId: string, owner: string): Promise<number | undefined> {
  const session = await dataClient.models.ChatSession.get({ id: sessionId })
  assertNoDataErrors(session.errors, 'Loading chat session for reset failed.')
  if (!session.data) {
    const generation = 1
    const created = await dataClient.models.ChatSession.create({
      id: sessionId,
      owner,
      title: 'リセット済みの会話',
      lastMessageAt: new Date().toISOString(),
      status: 'reset',
      generation,
      cleanupStatus: 'pending',
    })
    if (!created.errors?.length) return generation

    // A first chat request may race with reset and create the session between
    // our get and create. Re-read and transition that record to reset below.
    const raced = await dataClient.models.ChatSession.get({ id: sessionId })
    assertNoDataErrors(raced.errors, 'Loading concurrently created chat session failed.')
    if (!raced.data || raced.data.owner !== owner) {
      assertNoDataErrors(created.errors, 'Creating reset session tombstone failed.')
      throw new Error('Creating reset session tombstone failed.')
    }
    const racedGeneration = raced.data.status === 'reset'
      ? normalizeSessionGeneration(raced.data.generation)
      : normalizeSessionGeneration(raced.data.generation) + 1
    const resetRaced = await dataClient.models.ChatSession.update({
      id: sessionId,
      status: 'reset',
      generation: racedGeneration,
      cleanupStatus: 'pending',
      lastMessageAt: new Date().toISOString(),
    })
    assertNoDataErrors(resetRaced.errors, 'Marking concurrently created session as reset failed.')
    return racedGeneration
  }
  if (session.data.owner !== owner) {
    throw new Error('The requested chat session does not belong to this user.')
  }

  const generation = session.data.status === 'reset'
    ? normalizeSessionGeneration(session.data.generation)
    : normalizeSessionGeneration(session.data.generation) + 1
  const updated = await dataClient.models.ChatSession.update({
    id: sessionId,
    status: 'reset',
    generation,
    cleanupStatus: 'pending',
    lastMessageAt: new Date().toISOString(),
  })
  assertNoDataErrors(updated.errors, 'Marking chat session as reset failed.')
  return generation
}

async function runAsyncResetTask(taskEvent: AsyncResetTaskEvent): Promise<void> {
  const session = await dataClient.models.ChatSession.get({ id: taskEvent.sessionId })
  assertNoDataErrors(session.errors, 'Loading chat session for cleanup failed.')
  if (
    !session.data
    || session.data.owner !== taskEvent.runtimeUserId
    || session.data.status !== 'reset'
    || normalizeSessionGeneration(session.data.generation) !== taskEvent.sessionGeneration
  ) return

  let consecutiveEmptyPasses = 0
  for (let pass = 0; pass < 8; pass += 1) {
    const deletedCount = await deleteConversationMessagesPass(taskEvent)
    consecutiveEmptyPasses = deletedCount === 0 ? consecutiveEmptyPasses + 1 : 0
    if (consecutiveEmptyPasses >= 5) {
      const completed = await dataClient.models.ChatSession.update({
        id: taskEvent.sessionId,
        cleanupStatus: 'complete',
      })
      assertNoDataErrors(completed.errors, 'Completing conversation cleanup failed.')
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (2 ** pass)))
  }

  // Throwing lets Lambda's asynchronous invocation retry policy run this task
  // again. The pending tombstone also allows a future chat request to requeue it.
  throw new Error('Conversation cleanup did not reach five consecutive empty passes.')
}

async function deleteConversationMessagesPass(
  taskEvent: AsyncResetTaskEvent,
): Promise<number> {
  let deletedCount = 0
  let nextToken: string | null | undefined
  do {
    const result = await dataClient.models.ChatMessage.listChatMessagesBySession(
      { sessionId: taskEvent.sessionId },
      {
        sortDirection: 'ASC',
        limit: 100,
        nextToken,
      },
    )
    assertNoDataErrors(result.errors, 'Loading chat messages for cleanup failed.')
    const messages = result.data ?? []
    deletedCount += messages.length
    if (messages.some((message) => message.owner !== taskEvent.runtimeUserId)) {
      throw new Error('The requested chat session contains messages owned by another user.')
    }

    for (let offset = 0; offset < messages.length; offset += 20) {
      const batch = messages.slice(offset, offset + 20)
      await Promise.all(batch.map(async (message) => {
        const deleted = await dataClient.models.ChatMessage.delete({ id: message.id })
        assertNoDataErrors(deleted.errors, 'Deleting chat message failed.')
      }))
    }
    nextToken = result.nextToken
  } while (nextToken)
  return deletedCount
}

async function deletePersistedMessage(
  requestId: string,
  role: 'user' | 'assistant',
): Promise<void> {
  const deleted = await dataClient.models.ChatMessage.delete({
    id: `${requestId}-${role}`,
  })
  assertNoDataErrors(deleted.errors, 'Deleting stale chat message failed.')
}

function normalizeSessionGeneration(value: number | null | undefined): number {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1
}

function createSessionTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  return normalized.length > 40 ? `${normalized.slice(0, 40)}…` : normalized
}

function assertNoDataErrors(
  errors: ReadonlyArray<{ message?: string | null } | null | undefined> | undefined,
  fallback: string,
): void {
  if (!errors?.length) return
  const detail = errors.map((error) => error?.message).filter(Boolean).join(' / ')
  throw new Error(detail || fallback)
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
  requestId: string,
  sequence: number,
  delta: string | undefined,
  done: boolean,
  error?: string,
): Promise<void> {
  const result = await dataClient.mutations.publishChunk({
    sessionId,
    requestId,
    sequence,
    delta: delta ?? null,
    done,
    error: error ?? null,
  })

  if (Array.isArray(result.errors) && result.errors.length > 0) {
    const detail = result.errors.map((e) => e?.message).filter(Boolean).join(' / ')
    throw new Error(detail || 'publishChunk failed.')
  }
}

async function publishChunkWithRetry(
  taskEvent: Pick<AsyncChatTaskEvent, 'sessionId' | 'requestId'>,
  sequence: number,
  delta: string | undefined,
  done: boolean,
  error?: string,
): Promise<void> {
  const retryDelaysMs = [0, 100, 300]
  let lastError: unknown

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    try {
      await publishChunk(taskEvent.sessionId, taskEvent.requestId, sequence, delta, done, error)
      return
    } catch (error) {
      lastError = error
    }
  }

  throw lastError
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
  if ('claims' in identity && identity.claims && typeof identity.claims === 'object') {
    const claims = identity.claims as Record<string, unknown>
    if (typeof claims.sub === 'string') return claims.sub
    if (typeof claims['cognito:username'] === 'string') return claims['cognito:username']
  }
  return undefined
}

function isAsyncChatTaskEvent(value: unknown): value is AsyncChatTaskEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.task === CHAT_TASK_NAME
    && typeof record.prompt === 'string'
    && typeof record.sessionId === 'string'
    && typeof record.requestId === 'string'
    && typeof record.runtimeUserId === 'string'
    && typeof record.startedAt === 'string'
    && typeof record.sessionGeneration === 'number'
  )
}

function isAsyncResetTaskEvent(value: unknown): value is AsyncResetTaskEvent {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.task === RESET_TASK_NAME
    && typeof record.sessionId === 'string'
    && typeof record.runtimeUserId === 'string'
    && typeof record.sessionGeneration === 'number'
  )
}


