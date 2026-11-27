// The ego mirror: ego lite owns the page and its window; this panel shows the same
// page as the frames the bridge streams, and sends pointer and keyboard straight back.
// It is a view over ego, not a second browser: the Bot and the user share one page.
import { createElement as h, useEffect, useRef, useState } from 'react'

const POLL_MS = 250

const namedKeys = new Set(['Enter', 'Tab', 'Backspace', 'Escape', 'Delete', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'])

export function EgoBrowserView({ bot, actions }) {
  const [frame, setFrame] = useState(null)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const seq = useRef(0)
  const stage = useRef(null)
  const sent = useRef(0)

  useEffect(() => {
    let alive = true
    let timer = 0
    const tick = async () => {
      try {
        const next = await actions.egoFrame(bot.id, seq.current)
        if (!alive) return
        if (next && typeof next.seq === 'number' && next.seq !== seq.current) {
          seq.current = next.seq
          setFrame(next)
          setError(null)
        }
      } catch (failure) {
        if (alive) setError(failure?.message ?? String(failure))
      }
      if (alive) timer = setTimeout(tick, POLL_MS)
    }
    tick()
    return () => { alive = false; clearTimeout(timer) }
  }, [bot.id, actions])

  const send = event => {
    sent.current += 1
    void Promise.resolve(actions.egoInput(bot.id, event)).catch(() => {})
  }

  const point = event => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    return {
      x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
    }
  }

  const onPointerDown = event => {
    if (event.button !== 0) return
    const at = point(event)
    if (at === null) return
    stage.current?.focus?.()
    send({ type: 'click', ...at })
  }

  const onWheel = event => {
    const at = point(event)
    send({ type: 'wheel', x: at?.x ?? 0.5, y: at?.y ?? 0.5, deltaX: event.deltaX, deltaY: event.deltaY })
  }

  const onKeyDown = event => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.length === 1) {
      event.preventDefault()
      send({ type: 'insert', text: event.key })
      return
    }
    if (namedKeys.has(event.key)) {
      event.preventDefault()
      send({ type: 'key', key: event.key })
    }
  }

  const navigate = () => {
    let url = draft.trim()
    if (url === '') return
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`
    try { new URL(url) } catch { return }
    const current = frame?.url ?? ''
    setEditing(false)
    if (url === current) return
    send({ type: 'navigate', url })
  }

  const shown = editing ? draft : (frame?.url ?? '')

  return h('div', { className: 'bt-ego' },
    h('div', { className: 'bt-ego-bar' },
      h('span', { className: 'bt-ego-badge' }, 'ego'),
      h('input', {
        className: 'bt-ego-address',
        value: shown,
        spellCheck: false,
        placeholder: 'ego lite',
        onFocus: () => { setDraft(frame?.url ?? ''); setEditing(true) },
        onChange: event => setDraft(event.target.value),
        onBlur: () => { setEditing(false) },
        onKeyDown: event => {
          if (event.key === 'Enter') { event.preventDefault(); navigate(); event.currentTarget.blur() }
          if (event.key === 'Escape') { setEditing(false); event.currentTarget.blur() }
        },
      }),
      frame?.title ? h('span', { className: 'bt-ego-title' }, frame.title) : null,
    ),
    h('div', {
      ref: stage,
      className: 'bt-ego-stage',
      tabIndex: 0,
      role: 'application',
      'aria-label': `${bot.name}'s ego page`,
      onPointerDown,
      onWheel,
      onKeyDown,
    },
      frame
        ? h('img', {
            className: 'bt-ego-frame',
            src: `data:${frame.mime};base64,${frame.data}`,
            draggable: false,
            alt: '',
          })
        : h('div', { className: 'bt-ego-empty' }, error ? error : 'Connecting to ego…'),
    ),
  )
}
