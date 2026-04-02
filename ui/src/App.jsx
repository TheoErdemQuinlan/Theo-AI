import React, { useState, useEffect, useRef, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const API = ''  // same origin via vite proxy

function useSession() {
  const [sessionId, setSessionId] = useState(null)
  const [cwd, setCwd] = useState('')
  const [proxyOk, setProxyOk] = useState(null)

  useEffect(() => {
    // Health check
    fetch(`${API}/api/health`)
      .then(r => r.json())
      .then(d => setProxyOk(d.proxy))
      .catch(() => setProxyOk(false))

    // Create session
    fetch(`${API}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '' }),
    })
      .then(r => r.json())
      .then(d => { setSessionId(d.session_id); setCwd(d.cwd) })
  }, [])

  return { sessionId, cwd, setCwd, proxyOk }
}

// ── Message types ──────────────────────────────────────────────────────────
function ToolCall({ name, input }) {
  const [open, setOpen] = useState(false)
  const keyParam = input?.command || input?.path || input?.pattern || ''
  return (
    <div className="tool-call" onClick={() => setOpen(o => !o)}>
      <span className="tool-icon">⚡</span>
      <span className="tool-name">{name}</span>
      {keyParam && <span className="tool-param">{String(keyParam).slice(0, 80)}</span>}
      <span className="tool-toggle">{open ? '▲' : '▼'}</span>
      {open && (
        <pre className="tool-input">{JSON.stringify(input, null, 2)}</pre>
      )}
    </div>
  )
}

function ToolResult({ name, result }) {
  const [open, setOpen] = useState(false)
  const lines = result ? result.split('\n').length : 0
  const preview = result ? result.slice(0, 120).replace(/\n/g, ' ') : ''
  return (
    <div className="tool-result" onClick={() => setOpen(o => !o)}>
      <span className="result-icon">✓</span>
      <span className="result-preview">{preview}{result?.length > 120 ? '...' : ''}</span>
      <span className="result-meta">{lines} lines</span>
      <span className="tool-toggle">{open ? '▲' : '▼'}</span>
      {open && <pre className="tool-output">{result}</pre>}
    </div>
  )
}

function Message({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-avatar user-avatar">T</div>
        <div className="msg-body">
          <div className="msg-text">{msg.content}</div>
        </div>
      </div>
    )
  }

  if (msg.role === 'assistant') {
    return (
      <div className="msg msg-assistant">
        <div className="msg-avatar ai-avatar">⚡</div>
        <div className="msg-body">
          {msg.parts?.map((part, i) => {
            if (part.type === 'text') {
              return (
                <div key={i} className="msg-markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
                </div>
              )
            }
            if (part.type === 'tool_call') {
              return <ToolCall key={i} name={part.name} input={part.input} />
            }
            if (part.type === 'tool_result') {
              return <ToolResult key={i} name={part.name} result={part.result} />
            }
            return null
          })}
          {msg.streaming && <span className="cursor">▋</span>}
        </div>
      </div>
    )
  }

  if (msg.role === 'error') {
    return (
      <div className="msg msg-error">
        <div className="msg-avatar error-avatar">!</div>
        <div className="msg-body">
          <div className="msg-error-text">{msg.content}</div>
        </div>
      </div>
    )
  }

  return null
}

// ── Header ────────────────────────────────────────────────────────────────
function Header({ cwd, setCwd, sessionId, proxyOk, onClear, msgCount }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(cwd)

  const submitCwd = () => {
    if (!sessionId || !draft.trim()) return
    fetch(`${API}/api/session/${sessionId}/cwd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: draft }),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) setCwd(d.cwd) })
    setEditing(false)
  }

  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <span className="logo-tc">TC</span>
          <div className="logo-text">
            <span className="logo-name">Theo Code</span>
            <span className="logo-sub">Sovereign Coding Intelligence</span>
          </div>
        </div>
      </div>

      <div className="header-center">
        {editing ? (
          <input
            className="cwd-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={submitCwd}
            onKeyDown={e => { if (e.key === 'Enter') submitCwd(); if (e.key === 'Escape') setEditing(false) }}
            autoFocus
          />
        ) : (
          <button className="cwd-btn" onClick={() => { setDraft(cwd); setEditing(true) }} title="Click to change directory">
            <span className="cwd-icon">📁</span>
            <span className="cwd-text">{cwd || '~'}</span>
          </button>
        )}
      </div>

      <div className="header-right">
        <div className={`proxy-dot ${proxyOk === true ? 'online' : proxyOk === false ? 'offline' : 'unknown'}`}
          title={proxyOk === true ? 'NIM proxy online' : 'NIM proxy offline'} />
        <span className="proxy-label">NIM</span>
        {msgCount > 0 && (
          <button className="clear-btn" onClick={onClear} title="Clear conversation">
            Clear
          </button>
        )}
      </div>
    </header>
  )
}

// ── Status bar ────────────────────────────────────────────────────────────
function StatusBar({ status, usage }) {
  return (
    <div className="statusbar">
      <span className="status-model">Qwen3-Coder 480B · NVIDIA NIM</span>
      <span className="status-sep">·</span>
      <span className={`status-state state-${status}`}>
        {status === 'idle' ? 'Ready' : status === 'streaming' ? 'Thinking...' : status === 'tools' ? 'Using tools...' : status}
      </span>
      {usage.total_in > 0 && (
        <>
          <span className="status-sep">·</span>
          <span className="status-tokens">{usage.total_in.toLocaleString()} in / {usage.total_out.toLocaleString()} out</span>
        </>
      )}
    </div>
  )
}

// ── Input bar ─────────────────────────────────────────────────────────────
function InputBar({ onSend, disabled }) {
  const [value, setValue] = useState('')
  const ref = useRef(null)

  const send = () => {
    const v = value.trim()
    if (!v || disabled) return
    onSend(v)
    setValue('')
    if (ref.current) {
      ref.current.style.height = 'auto'
    }
  }

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const onInput = (e) => {
    setValue(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
  }

  return (
    <div className="inputbar">
      <textarea
        ref={ref}
        className="input-textarea"
        value={value}
        onChange={onInput}
        onKeyDown={onKey}
        placeholder="Ask Theo Code anything... (Enter to send, Shift+Enter for newline)"
        disabled={disabled}
        rows={1}
      />
      <button
        className={`send-btn ${disabled ? 'disabled' : value.trim() ? 'active' : ''}`}
        onClick={send}
        disabled={disabled || !value.trim()}
      >
        {disabled ? '⏳' : '↑'}
      </button>
    </div>
  )
}

// ── Suggestions ────────────────────────────────────────────────────────────
const SUGGESTIONS = [
  'Read the main files in this directory and explain the project structure',
  'Find all TODO comments in the codebase',
  'What tests exist and how do I run them?',
  'Check git status and summarise recent changes',
]

function Suggestions({ onSelect }) {
  return (
    <div className="suggestions">
      <div className="suggestions-title">Suggestions</div>
      <div className="suggestions-list">
        {SUGGESTIONS.map((s, i) => (
          <button key={i} className="suggestion-btn" onClick={() => onSelect(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const { sessionId, cwd, setCwd, proxyOk } = useSession()
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('idle')
  const [usage, setUsage] = useState({ total_in: 0, total_out: 0 })
  const bottomRef = useRef(null)
  const abortRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const clearChat = useCallback(() => {
    if (!sessionId) return
    fetch(`${API}/api/session/${sessionId}/clear`, { method: 'POST' })
    setMessages([])
    setStatus('idle')
  }, [sessionId])

  const sendMessage = useCallback(async (text) => {
    if (!sessionId || status !== 'idle') return

    // Add user message
    setMessages(prev => [...prev, { role: 'user', content: text, id: Date.now() }])

    // Add placeholder assistant message
    const aiId = Date.now() + 1
    setMessages(prev => [...prev, {
      role: 'assistant', id: aiId, streaming: true,
      parts: [{ type: 'text', content: '' }]
    }])
    setStatus('streaming')

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const resp = await fetch(`${API}/api/chat/${sessionId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
        signal: controller.signal,
      })

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue
          let event
          try { event = JSON.parse(data) } catch { continue }

          if (event.type === 'text') {
            setMessages(prev => prev.map(m => {
              if (m.id !== aiId) return m
              const parts = [...m.parts]
              const last = parts[parts.length - 1]
              if (last?.type === 'text') {
                parts[parts.length - 1] = { ...last, content: last.content + event.text }
              } else {
                parts.push({ type: 'text', content: event.text })
              }
              return { ...m, parts }
            }))
          }

          if (event.type === 'tool_call') {
            setStatus('tools')
            setMessages(prev => prev.map(m => {
              if (m.id !== aiId) return m
              return { ...m, parts: [...m.parts, { type: 'tool_call', name: event.name, input: event.input }] }
            }))
          }

          if (event.type === 'tool_result') {
            setMessages(prev => prev.map(m => {
              if (m.id !== aiId) return m
              return { ...m, parts: [...m.parts, { type: 'tool_result', name: event.name, result: event.result }] }
            }))
            setStatus('streaming')
          }

          if (event.type === 'usage') {
            setUsage(prev => ({
              total_in: prev.total_in + (event.input_tokens || 0),
              total_out: prev.total_out + (event.output_tokens || 0),
            }))
          }

          if (event.type === 'error') {
            setMessages(prev => prev.map(m => m.id === aiId
              ? { ...m, streaming: false }
              : m
            ))
            setMessages(prev => [...prev, { role: 'error', content: event.message, id: Date.now() }])
            setStatus('idle')
            return
          }

          if (event.type === 'done') {
            setMessages(prev => prev.map(m => m.id === aiId ? { ...m, streaming: false } : m))
            setStatus('idle')
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'error', content: String(err), id: Date.now() }])
      }
      setStatus('idle')
    }
  }, [sessionId, status])

  return (
    <div className="app">
      <Header
        cwd={cwd} setCwd={setCwd}
        sessionId={sessionId} proxyOk={proxyOk}
        onClear={clearChat} msgCount={messages.length}
      />

      <main className="main">
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-logo">⚡</div>
            <h1 className="welcome-title">Theo Code</h1>
            <p className="welcome-sub">Sovereign Coding Intelligence · Built by Theodore Quinlan</p>
            <p className="welcome-model">Qwen3-Coder 480B · Nemotron Ultra 253B · NVIDIA NIM</p>
            <Suggestions onSelect={sendMessage} />
          </div>
        ) : (
          <div className="messages">
            {messages.map(msg => <Message key={msg.id} msg={msg} />)}
            <div ref={bottomRef} />
          </div>
        )}
      </main>

      <div className="bottom">
        <InputBar onSend={sendMessage} disabled={status !== 'idle'} />
        <StatusBar status={status} usage={usage} />
      </div>
    </div>
  )
}
