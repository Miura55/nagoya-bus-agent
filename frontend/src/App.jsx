import { useEffect, useRef, useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import { generateClient } from 'aws-amplify/data'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const client = generateClient()
const ASYNC_ACK_REPLY = '処理を開始しました。回答を順次配信します。'

function App({ configError }) {
  if (configError) {
    return (
      <main className="shell shell--narrow">
        <section className="setup-card">
          <p className="eyebrow">Amplify Setup Required</p>
          <h1>チャットを起動できません</h1>
          <p className="setup-copy">{configError}</p>
          <p className="setup-hint">
            backend をデプロイして amplify_outputs.json を生成したあと、もう一度起動してください。
          </p>
        </section>
      </main>
    )
  }

  return (
    <Authenticator loginMechanisms={['email']}>
      {({ signOut, user }) => <ChatWorkspace signOut={signOut} user={user} />}
    </Authenticator>
  )
}

function ChatWorkspace({ signOut, user }) {
  const [messages, setMessages] = useState(() => [
    {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '名古屋市営バスについて、路線、行き先、最寄りの停留所などを質問してください。',
    },
  ])
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID())
  const [isSending, setIsSending] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const endRef = useRef(null)
  const isComposingRef = useRef(false)

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isSending])

  async function handleSubmit(event) {
    event.preventDefault()

    const nextPrompt = prompt.trim()

    if (!nextPrompt || isSending) {
      return
    }

    const userMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: nextPrompt,
    }

    // Add the user message and a placeholder assistant message immediately.
    const assistantId = crypto.randomUUID()
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', text: '', streaming: true },
    ])
    setPrompt('')
    setErrorMessage('')
    setIsSending(true)

    // Subscribe to streaming chunks before sending the mutation so no
    // early deltas are missed.
    const canSubscribe = typeof client?.subscriptions?.onChatChunk === 'function'
    let sub = null

    if (canSubscribe) {
      sub = client
        .subscriptions.onChatChunk({ sessionId })
        .subscribe({
          next: (event) => {
            const chunk = event?.data ?? event
            if (chunk?.eventType === 'current_tool_use') {
              setMessages((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  role: 'assistant',
                  text: `[tool] ${chunk.delta ?? 'tool called'}`,
                  isToolEvent: true,
                },
              ])
              return
            }

            if (chunk?.delta) {
              setMessages((current) =>
                current.map((msg) =>
                  msg.id === assistantId
                    ? { ...msg, text: msg.text + chunk.delta }
                    : msg,
                ),
              )
            }
            if (chunk?.done) {
              setMessages((current) =>
                current.map((msg) =>
                  msg.id === assistantId ? { ...msg, streaming: false } : msg,
                ),
              )
              if (chunk?.error) {
                setErrorMessage(chunk.error)
              }
              setIsSending(false)
              sub?.unsubscribe()
            }
          },
          error: (err) => {
            console.error('Streaming subscription error:', err)
            setErrorMessage('ストリーミングの購読中にエラーが発生しました。')
            setIsSending(false)
            setMessages((current) =>
              current.map((msg) =>
                msg.id === assistantId ? { ...msg, streaming: false } : msg,
              ),
            )
            sub?.unsubscribe()
          },
        })
    }

    try {
      const result = await client.mutations.chat({
        prompt: nextPrompt,
        sessionId,
      })

      if (Array.isArray(result?.errors) && result.errors.length > 0) {
        const details = result.errors
          .map((entry) => entry?.message)
          .filter(Boolean)
          .join(' / ')
        throw new Error(details || 'チャット API がエラーを返しました。')
      }

      const response = result?.data?.chat ?? result?.data ?? result
      const parsedReply = extractAssistantMessage(response?.reply)
      const isAsyncAck = response?.statusCode === 202 || parsedReply === ASYNC_ACK_REPLY

      if (response?.sessionId) {
        setSessionId(response.sessionId)
      }

      if (parsedReply && (!canSubscribe || !isAsyncAck)) {
        setMessages((current) =>
          current.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  text: parsedReply,
                  streaming: false,
                  traceId: response?.traceId,
                }
              : msg,
          ),
        )
        setIsSending(false)
        sub?.unsubscribe()
      }
    } catch (error) {
      const fallback = '現在エージェントに接続できません。数秒おいて再試行してください。'
      setErrorMessage(error instanceof Error ? error.message || fallback : fallback)
      // Remove the empty placeholder if the request failed entirely.
      setMessages((current) => current.filter((msg) => msg.id !== assistantId))
      setIsSending(false)
      sub?.unsubscribe()
    } finally {
      // Do not unsubscribe here. Streaming should continue after ACK until done arrives.
    }
  }

  function handleKeyDown(event) {
    const nativeEvent = event.nativeEvent
    const isComposing =
      isComposingRef.current || nativeEvent?.isComposing || nativeEvent?.keyCode === 229

    if (isComposing) {
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSubmit(event)
    }
  }

  function handleCompositionStart() {
    isComposingRef.current = true
  }

  function handleCompositionEnd() {
    isComposingRef.current = false
  }

  const userLabel = user?.signInDetails?.loginId ?? user?.username ?? 'Signed-in user'

  return (
    <main className="shell">
      <section className="hero-panel">
        <div>
          <h2>名古屋市バス案内チャット</h2>
          <p className="hero-copy">
            名古屋市営バスで指定した系統の時刻や運行情報を質問できます
          </p>
        </div>
        <div className="hero-meta">
          <span className="pill">{userLabel}</span>
          <span className="pill pill--soft">session {sessionId.slice(0, 8)}</span>
          <button className="ghost-button" type="button" onClick={() => signOut?.()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="chat-card" aria-busy={isSending}>
        <header className="chat-card__header">
          <div>
            <h3>Chat</h3>
          </div>
        </header>

        <div className="message-list" aria-live="polite">
          {messages.map((message) => (
            <article
              key={message.id}
              className={`message message--${message.role}`}
            >
              <p className="message__role">
                {message.role === 'assistant' ? 'Agent' : 'You'}
              </p>
              {message.isToolEvent ? (
                <p className="message__body">{message.text}</p>
              ) : null}
              {!message.isToolEvent && message.role === 'assistant' ? (
                <div className="message__body message__body--markdown">
                  {message.text ? (
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {message.text + (message.streaming ? '\u258c' : '')}
                    </Markdown>
                  ) : message.streaming ? (
                    <span className="streaming-cursor">{'\u258c'}</span>
                  ) : null}
                </div>
              ) : (
                !message.isToolEvent ? <p className="message__body">{message.text}</p> : null
              )}
              {message.traceId ? (
                <p className="message__meta">trace {message.traceId}</p>
              ) : null}
            </article>
          ))}

          {isSending && !messages.some((m) => m.streaming) ? (
            <article className="message message--assistant message--pending">
              <p className="message__role">Agent</p>
              <p className="message__body">応答を取得しています...</p>
            </article>
          ) : null}

          <div ref={endRef} />
        </div>

        {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

        <form className="composer" onSubmit={handleSubmit}>
          <label className="sr-only" htmlFor="chat-prompt">
            バスに関する質問
          </label>
          <textarea
            id="chat-prompt"
            className="composer__input"
            rows="4"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={handleKeyDown}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="例: 栄から名古屋駅へ行くバスはありますか"
            disabled={isSending}
          />
          <div className="composer__footer">
            <p>Enter で送信、Shift + Enter で改行</p>
            <button className="send-button" type="submit" disabled={isSending || !prompt.trim()}>
              {isSending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}

function extractAssistantMessage(rawReply) {
  const normalized = typeof rawReply === 'string' ? rawReply.trim() : ''

  if (!normalized) {
    return ''
  }

  const parsed = parseStreamPayload(normalized)
  const chunks = extractTextChunks(parsed)

  if (chunks.length > 0) {
    return chunks.join('')
  }

  return normalized
}

function parseStreamPayload(payload) {
  try {
    return JSON.parse(payload)
  } catch {
    const lines = payload
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)

    if (lines.length === 0) {
      return payload
    }

    const streamEvents = []

    for (const line of lines) {
      if (line.startsWith(':')) {
        continue
      }

      if (line.startsWith('event:')) {
        continue
      }

      const dataLine = line.startsWith('data:') ? line.slice(5).trim() : line

      if (!dataLine || dataLine === '[DONE]') {
        continue
      }

      try {
        streamEvents.push(JSON.parse(dataLine))
      } catch {
        return payload
      }
    }

    return streamEvents.length > 0 ? streamEvents : payload
  }
}

function extractTextChunks(value) {
  if (typeof value === 'string') {
    return value ? [value] : []
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextChunks(item))
  }

  if (!value || typeof value !== 'object') {
    return []
  }

  const record = value
  const collected = []

  if (typeof record.text === 'string') {
    collected.push(record.text)
  }

  if (typeof record.outputText === 'string') {
    collected.push(record.outputText)
  }

  const delta = record.delta
  if (delta && typeof delta === 'object') {
    if (typeof delta.text === 'string') {
      collected.push(delta.text)
    }
  }

  const contentBlockDelta = record.contentBlockDelta
  if (contentBlockDelta && typeof contentBlockDelta === 'object') {
    const blockDelta = contentBlockDelta.delta
    if (blockDelta && typeof blockDelta === 'object' && typeof blockDelta.text === 'string') {
      collected.push(blockDelta.text)
    }
  }

  const content = record.content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === 'object' && typeof item.text === 'string') {
        collected.push(item.text)
      }
    }
  }

  for (const [key, nestedValue] of Object.entries(record)) {
    if (
      key === 'text' ||
      key === 'outputText' ||
      key === 'delta' ||
      key === 'contentBlockDelta' ||
      key === 'content'
    ) {
      continue
    }

    if (!nestedValue || typeof nestedValue !== 'object') {
      continue
    }

    collected.push(...extractTextChunks(nestedValue))
  }

  return collected
}

export default App
