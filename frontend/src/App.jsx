import { useEffect, useRef, useState } from 'react'
import { Authenticator } from '@aws-amplify/ui-react'
import { generateClient } from 'aws-amplify/api'
import './App.css'

const client = generateClient()

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

    setMessages((current) => [...current, userMessage])
    setPrompt('')
    setErrorMessage('')
    setIsSending(true)

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
      const reply = response?.reply?.trim()

      if (!reply) {
        console.error('Unexpected chat response payload:', result)
        throw new Error('エージェントの応答を解釈できませんでした。')
      }

      if (response?.sessionId) {
        setSessionId(response.sessionId)
      }

      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: reply,
          traceId: response?.traceId,
        },
      ])
    } catch (error) {
      const fallback = '現在エージェントに接続できません。数秒おいて再試行してください。'
      setErrorMessage(error instanceof Error ? error.message || fallback : fallback)
    } finally {
      setIsSending(false)
    }
  }

  function handleKeyDown(event) {
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
          <p className="eyebrow">Bedrock Agent Core</p>
          <h1>名古屋バス案内チャット</h1>
          <p className="hero-copy">
            Amplify 認証後に、名古屋市営バスの系統、停留所、行き先を会話形式で確認できます。
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
            <h2>Conversation</h2>
            <p>質問を送ると Agent Core runtime へ中継されます。</p>
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
              <p className="message__body">{message.text}</p>
              {message.traceId ? (
                <p className="message__meta">trace {message.traceId}</p>
              ) : null}
            </article>
          ))}

          {isSending ? (
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

export default App
