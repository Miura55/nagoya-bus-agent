import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore'

import type { Schema } from '../../data/resource'

const textDecoder = new TextDecoder()

const agentClient = new BedrockAgentCoreClient({
  region: process.env.AGENTCORE_REGION ?? process.env.AWS_REGION ?? 'ap-northeast-1',
})

const INVOKE_TIMEOUT_MS = 28_000

export const handler: Schema['chat']['functionHandler'] = async (event) => {
  const fieldName = (event as { fieldName?: string }).fieldName
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

  const rawResponse = await readResponseBody(response.response)
  const reply = extractReply(rawResponse)

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

async function readResponseBody(
  stream: { transformToString?: () => Promise<string>; transformToByteArray?: () => Promise<Uint8Array> } | undefined,
) {
  if (!stream) {
    return ''
  }

  if (typeof stream.transformToString === 'function') {
    return stream.transformToString()
  }

  if (typeof stream.transformToByteArray === 'function') {
    return textDecoder.decode(await stream.transformToByteArray())
  }

  return ''
}

function isAbortError(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false
  }

  const name = 'name' in error ? error.name : undefined
  const message = 'message' in error ? String(error.message) : ''

  return name === 'AbortError' || /aborted|abort/i.test(message)
}

function extractReply(rawResponse: string) {
  const normalized = rawResponse.trim()

  if (!normalized) {
    return ''
  }

  const parsed = parseStructuredPayload(normalized)
  const textSegments = extractContentBlockDeltaTexts(parsed)

  if (textSegments.length > 0) {
    return textSegments.join('').trim()
  }

  return normalized
}

function parseStructuredPayload(payload: string) {
  try {
    return JSON.parse(payload)
  } catch {
    const lines = payload
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim()
        // SSE形式 "data: {...}" のプレフィックスを除去する
        return trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
      })
      .filter(Boolean)

    if (lines.length === 0) {
      return payload
    }

    const parsedLines = []

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
