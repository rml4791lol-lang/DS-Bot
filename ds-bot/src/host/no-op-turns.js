// Classify recent Bot turns that contain no work and no human-facing answer.
// Reading the session log is the only way to correct turns recorded before the
// live turn filter existed; the result is persisted in the same exchange-turn
// index the client already uses to hide Bot-to-Bot traffic.
import { textOf } from './text.js'
import { isAcknowledgementOnlyText } from '../shared/idle-text.js'

const turnOf = (event, current) => {
  const turn = event?.data?.turn
  return Number.isFinite(turn) ? turn : current
}

const blocksOf = event => Array.isArray(event?.data?.message?.content) ? event.data.message.content : []

// Events are chronological. A turn/start opens the scope; later events without
// their own turn use that scope, matching how DSH writes a Session log.
export function classifyInternalNoOpTurns(events) {
  const turns = new Map()
  let current
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') {
      current = Number.isFinite(event.data?.turn) ? event.data.turn : current
      if (current !== undefined) turns.set(current, { turn: current, source: undefined, reason: undefined, tools: 0, texts: [], payload: false })
      continue
    }
    const turn = turnOf(event, current)
    if (turn === undefined) continue
    const entry = turns.get(turn) ?? { turn, source: undefined, reason: undefined, tools: 0, texts: [], payload: false }
    turns.set(turn, entry)
    if (event.type === 'user/message') {
      const source = event.data?.source
      if (typeof source?.kind === 'string') entry.source = source.kind
    } else if (event.type === 'tool/call') {
      entry.tools += 1
    } else if (event.type === 'assistant/message') {
      const blocks = blocksOf(event)
      entry.tools += blocks.filter(block => block?.type === 'tool-call').length
      entry.payload ||= blocks.some(block => block?.type === 'image' || block?.type === 'file')
      const text = textOf(blocks)
      if (text.trim() !== '') entry.texts.push(text)
    } else if (event.type === 'turn/end') {
      entry.reason = event.data?.reason?.kind
      current = undefined
    }
  }
  return [...turns.values()]
    .filter(entry => {
      const onlyAcknowledgement = entry.texts.length > 0 && entry.texts.every(isAcknowledgementOnlyText)
      const emptyWithNoWork = entry.texts.length === 0 && entry.tools === 0
      return entry.reason === 'completed'
        && entry.source !== undefined
        && entry.source !== 'user'
        && !entry.payload
        && (onlyAcknowledgement || emptyWithNoWork)
    })
    .map(entry => entry.turn)
}
