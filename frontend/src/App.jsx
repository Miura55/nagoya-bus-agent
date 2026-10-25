import { useEffect, useRef, useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import { generateClient } from 'aws-amplify/data'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import { createOrderedChunkConsumer } from './ordered-chunk-consumer.js'
import {
  createSessionTitle,
  normalizeStoredMessages,
  sortSessionsByRecent,
} from './chat-history.js'

const client = generateClient()
const ASYNC_ACK_REPLY = '処理を開始しました。回答を順次配信します。'
const WELCOME_TEXT = '名古屋市営バスについて、路線、行き先、最寄りの停留所などを質問してください。'

function createWelcomeMessages() {
  return [{ id: crypto.randomUUID(), role: 'assistant', text: WELCOME_TEXT }]
}

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
  const sessionStorageKey = `nagoya-bus-session-id:${user?.userId ?? 'anon'}`
  const [sessions, setSessions] = useState([])
  const [messages, setMessages] = useState(createWelcomeMessages)
  const [prompt, setPrompt] = useState('')
  const [sessionId, setSessionId] = useState(() => {
    try {
      return window.localStorage.getItem(sessionStorageKey) || crypto.randomUUID()
    } catch {
      return crypto.randomUUID()
    }
  })
  const [isSending, setIsSending] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const endRef = useRef(null)
  const isComposingRef = useRef(false)

  useEffect(() => {
    let cancelled = false

    async function restoreWorkspace() {
      setIsLoadingHistory(true)
      try {
        const storedSessions = await listAllSessions()
        if (cancelled) return

        setSessions(storedSessions)
        let savedSessionId = ''
        try {
          savedSessionId = window.localStorage.getItem(sessionStorageKey) ?? ''
        } catch {
          // Continue with the newest stored session.
        }

        const savedSession = storedSessions.find((session) => session.id === savedSessionId)
        // Keep the pre-database local session id when present. Its old display
        // history cannot be reconstructed, but the matching AgentCore Memory
        // remains usable and the next message registers it in the database.
        const selected = savedSession ?? (savedSessionId ? undefined : storedSessions[0])
        const nextSessionId = selected?.id ?? (savedSessionId || crypto.randomUUID())
        setSessionId(nextSessionId)

        if (selected) {
          const history = await listSessionMessages(nextSessionId)
          if (!cancelled) setMessages(history.length > 0 ? history : createWelcomeMessages())
        } else {
          setMessages(createWelcomeMessages())
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Restoring chat history failed:', error)
          setErrorMessage('会話履歴を読み込めませんでした。')
          setMessages(createWelcomeMessages())
        }
      } finally {
        if (!cancelled) setIsLoadingHistory(false)
      }
    }

    void restoreWorkspace()
    return () => {
      cancelled = true
    }
  }, [sessionStorageKey])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, isSending])

  useEffect(() => {
    if (isLoadingHistory) return
    try {
      window.localStorage.setItem(sessionStorageKey, sessionId)
    } catch {
      // The database remains the source of truth when localStorage is unavailable.
    }
  }, [isLoadingHistory, sessionId, sessionStorageKey])

  async function refreshSessions() {
    try {
      setSessions(await listAllSessions())
    } catch (error) {
      console.error('Refreshing sessions failed:', error)
    }
  }

  function handleNewSession() {
    if (isSending) return
    setSessionId(crypto.randomUUID())
    setMessages(createWelcomeMessages())
    setPrompt('')
    setErrorMessage('')
  }

  async function handleSelectSession(nextSessionId) {
    if (isSending || nextSessionId === sessionId) return
    setSessionId(nextSessionId)
    setMessages([])
    setErrorMessage('')
    setIsLoadingHistory(true)
    try {
      const history = await listSessionMessages(nextSessionId)
      setMessages(history.length > 0 ? history : createWelcomeMessages())
    } catch (error) {
      console.error('Loading chat history failed:', error)
      setErrorMessage('選択した会話を読み込めませんでした。')
      setMessages(createWelcomeMessages())
    } finally {
      setIsLoadingHistory(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()

    const nextPrompt = prompt.trim()
    if (!nextPrompt || isSending || isLoadingHistory) return

    const userMessage = { id: crypto.randomUUID(), role: 'user', text: nextPrompt }
    const assistantId = crypto.randomUUID()
    const requestId = crypto.randomUUID()
    const requestedSessionId = sessionId
    const now = new Date().toISOString()

    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', text: '', streaming: true },
    ])
    setSessions((current) => {
      const existing = current.find((session) => session.id === requestedSessionId)
      const updated = existing
        ? { ...existing, lastMessageAt: now }
        : { id: requestedSessionId, title: createSessionTitle(nextPrompt), lastMessageAt: now }
      return [updated, ...current.filter((session) => session.id !== requestedSessionId)]
    })
    setPrompt('')
    setErrorMessage('')
    setIsSending(true)

    const canSubscribe = typeof client?.subscriptions?.onChatChunk === 'function'
    let sub = null

    const orderedChunks = createOrderedChunkConsumer((chunk) => {
      if (chunk?.delta) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: `${message.text}${chunk.delta}` }
              : message,
          ),
        )
      }
      if (chunk?.done) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId ? { ...message, streaming: false } : message,
          ),
        )
        if (chunk?.error) setErrorMessage(chunk.error)
        setIsSending(false)
        sub?.unsubscribe()
        void refreshSessions()
      }
    })

    if (canSubscribe) {
      sub = client.subscriptions.onChatChunk({ sessionId: requestedSessionId, requestId }).subscribe({
        next: (event) => orderedChunks.push(event?.data ?? event),
        error: (error) => {
          console.error('Streaming subscription error:', error)
          setErrorMessage('ストリーミングの購読中にエラーが発生しました。')
          setIsSending(false)
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, streaming: false } : message,
            ),
          )
          sub?.unsubscribe()
        },
      })
    }

    try {
      const result = await client.mutations.chat({
        prompt: nextPrompt,
        sessionId: requestedSessionId,
        requestId,
      })

      throwForErrors(result?.errors, 'チャット API がエラーを返しました。')
      const response = result?.data?.chat ?? result?.data ?? result
      const parsedReply = extractAssistantMessage(response?.reply)
      const isAsyncAck = response?.statusCode === 202 || parsedReply === ASYNC_ACK_REPLY

      if (response?.sessionId && response.sessionId !== requestedSessionId) {
        setSessionId(response.sessionId)
      }

      if (parsedReply && (!canSubscribe || !isAsyncAck)) {
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantId
              ? { ...message, text: parsedReply, streaming: false, traceId: response?.traceId }
              : message,
          ),
        )
        setIsSending(false)
        sub?.unsubscribe()
        void refreshSessions()
      }
    } catch (error) {
      const fallback = '現在エージェントに接続できません。数秒おいて再試行してください。'
      setErrorMessage(error instanceof Error ? error.message || fallback : fallback)
      setMessages((current) => current.filter((message) => message.id !== assistantId))
      setIsSending(false)
      sub?.unsubscribe()
      void refreshSessions()
    }
  }

  function handleKeyDown(event) {
    const nativeEvent = event.nativeEvent
    const isComposing = isComposingRef.current || nativeEvent?.isComposing || nativeEvent?.keyCode === 229
    if (isComposing) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSubmit(event)
    }
  }

  const userLabel = user?.signInDetails?.loginId ?? user?.username ?? 'Signed-in user'

  return (
    <main className="shell">
      <section className="hero-panel">
        <div>
          <h2>名古屋市バス案内チャット</h2>
          <p className="hero-copy">名古屋市営バスで指定した系統の時刻や運行情報を質問できます</p>
        </div>
        <div className="hero-meta">
          <span className="pill">{userLabel}</span>
          <span className="pill pill--soft">session {sessionId.slice(0, 8)}</span>
          <button className="ghost-button" type="button" onClick={() => signOut?.()}>Sign out</button>
        </div>
      </section>

      <div className="workspace">
        <aside className="session-panel" aria-label="会話履歴">
          <div className="session-panel__header">
            <h3>会話履歴</h3>
            <button className="new-session-button" type="button" onClick={handleNewSession} disabled={isSending}>
              新しい会話
            </button>
          </div>
          <div className="session-list">
            {sessions.length === 0 ? (
              <p className="session-list__empty">保存された会話はまだありません。</p>
            ) : sessions.map((session) => (
              <button
                key={session.id}
                className={`session-item${session.id === sessionId ? ' session-item--active' : ''}`}
                type="button"
                onClick={() => void handleSelectSession(session.id)}
                disabled={isSending}
              >
                <span className="session-item__title">{session.title}</span>
                <span className="session-item__date">{formatSessionDate(session.lastMessageAt)}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="chat-card" aria-busy={isSending || isLoadingHistory}>
          <header className="chat-card__header"><h3>Chat</h3></header>

          <div className="message-list" aria-live="polite">
            {isLoadingHistory ? (
              <p className="history-loading">会話履歴を読み込んでいます...</p>
            ) : messages.map((message) => (
              <article key={message.id} className={`message message--${message.role}`}>
                <p className="message__role">{message.role === 'assistant' ? 'Agent' : 'You'}</p>
                {message.role === 'assistant' ? (
                  <div className="message__body message__body--markdown">
                    {message.text ? (
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {message.text + (message.streaming ? '\u258c' : '')}
                      </Markdown>
                    ) : message.streaming ? <span className="streaming-cursor">{'\u258c'}</span> : null}
                  </div>
                ) : <p className="message__body">{message.text}</p>}
                {message.traceId ? <p className="message__meta">trace {message.traceId}</p> : null}
              </article>
            ))}
            <div ref={endRef} />
          </div>

          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

          <form className="composer" onSubmit={handleSubmit}>
            <label className="sr-only" htmlFor="chat-prompt">バスに関する質問</label>
            <textarea
              id="chat-prompt"
              className="composer__input"
              rows="4"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => { isComposingRef.current = true }}
              onCompositionEnd={() => { isComposingRef.current = false }}
              placeholder="例: 栄から名古屋駅へ行くバスはありますか"
              disabled={isSending || isLoadingHistory}
            />
            <div className="composer__footer">
              <p>Enter で送信、Shift + Enter で改行</p>
              <button
                className="send-button"
                type="submit"
                disabled={isSending || isLoadingHistory || !prompt.trim()}
              >
                {isSending ? 'Sending...' : 'Send'}
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}

async function listAllSessions() {
  const sessions = []
  let nextToken
  do {
    const result = await client.models.ChatSession.list({ limit: 100, nextToken })
    throwForErrors(result?.errors, '会話一覧の取得に失敗しました。')
    sessions.push(...(result?.data ?? []))
    nextToken = result?.nextToken
  } while (nextToken)

  return sortSessionsByRecent(sessions)
}

async function listSessionMessages(sessionId) {
  const messages = []
  let nextToken
  do {
    const result = await client.models.ChatMessage.list({
      filter: { sessionId: { eq: sessionId } },
      limit: 100,
      nextToken,
    })
    throwForErrors(result?.errors, '会話メッセージの取得に失敗しました。')
    messages.push(...(result?.data ?? []))
    nextToken = result?.nextToken
  } while (nextToken)

  return normalizeStoredMessages(messages)
}

function throwForErrors(errors, fallback) {
  if (!Array.isArray(errors) || errors.length === 0) return
  const detail = errors.map((entry) => entry?.message).filter(Boolean).join(' / ')
  throw new Error(detail || fallback)
}

function formatSessionDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}

function extractAssistantMessage(rawReply) {
  return typeof rawReply === 'string' ? rawReply.trim() : ''
}

export default App
