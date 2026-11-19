import { commandFromArguments, toolResultFacts } from './task-evidence.js'

const text = value => (value === undefined || value === null ? '' : String(value))
const timeOf = value => {
  const time = typeof value === 'number' ? value : Date.parse(text(value))
  return Number.isFinite(time) ? time : null
}
const contentText = (content) => {
  if (!Array.isArray(content)) return ''
  return content.map(block => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n')
}

function eventTaskMatch(event, task, raw) {
  const data = event?.data ?? {}
  const source = data.source ?? {}
  const refs = new Set([
    data.taskId, data.goalTaskId, data.sourceId,
    source.taskId, source.goalTaskId, source.sourceId,
  ].map(text).filter(Boolean))
  const goalId = text(source.goalId ?? data.goalId)
  const stageId = text(source.stageId ?? data.stageId)
  const taskId = text(source.taskId ?? data.taskId)
  if (goalId && stageId && taskId) refs.add(`goal:${goalId}:${stageId}:${taskId}`)
  const attemptExchange = text(raw?.task?.attempt?.exchangeId ?? raw?.work?.attempt?.exchangeId)
  const matchesAttempt = attemptExchange !== '' && [source.exchangeId, data.exchangeId].some(value => text(value) === attemptExchange)
  if (task.source === 'handoff') {
    const workId = text(raw?.id)
    for (const value of [data.workId, source.workId, source.work, data.work, source.exchangeId, data.exchangeId]) {
      if (text(value) === workId) refs.add(workId)
    }
  }
  return matchesAttempt || refs.has(task.sourceId) || refs.has(task.id)
}

const turnOf = (event, current) => Number.isInteger(event?.data?.turn) ? event.data.turn : current

function matchedTurns(events, task, raw) {
  const turns = new Set()
  let current
  for (const event of events) {
    current = turnOf(event, current)
    if (Number.isInteger(current) && eventTaskMatch(event, task, raw)) turns.add(current)
  }
  return turns
}

function messageFields(type, data, task, redactText) {
  const assistant = type === 'assistant/message'
  return {
    trust: 'reported',
    titleKey: assistant ? 'trace.report' : 'trace.request',
    detail: redactText(contentText(assistant ? data.message?.content : data.content)),
    actor: assistant ? task.ownerName : null,
  }
}

function toolCallFields(data, calls, redactText) {
  const toolName = redactText(data.name)
  const detail = redactText(data.arguments)
  if (data.callId !== undefined) {
    calls.set(text(data.callId), {
      name: toolName,
      detail,
      command: commandFromArguments(data.arguments),
    })
  }
  return { trust: 'requested', titleKey: 'trace.toolCall', toolName, detail }
}

function toolResultFields(data, calls, redactText) {
  const call = calls.get(text(data.message?.toolCallId))
  const facts = toolResultFacts({ event: { data }, command: call?.command })
  const resultKey = facts.ok === false || (facts.exitCode !== undefined && facts.exitCode !== 0)
    ? 'trace.failed'
    : facts.ok === true || facts.exitCode === 0 ? 'trace.completed' : undefined
  return {
    trust: 'executed',
    titleKey: 'trace.toolResult',
    toolName: call?.name ?? '',
    requestDetail: call?.detail ?? '',
    detail: redactText(facts.output),
    ...(resultKey ? { resultKey } : {}),
    ...(facts.command === undefined ? {} : { command: { ...facts.command, text: redactText(facts.command.text) } }),
    ...(facts.diff === undefined ? {} : { diff: { ...facts.diff, paths: facts.diff.paths.map(redactText) } }),
  }
}

function artifactFields(data, redactText) {
  const files = Array.isArray(data.files) ? data.files.filter(file => typeof file?.path === 'string') : []
  const artifacts = files.map(file => {
    const path = redactText(file.path)
    return { path, name: redactText(file.name) || path.split(/[\\/]/).pop(), digest: text(file.digest) || null, trust: 'executed' }
  })
  return {
    fields: {
      trust: 'executed',
      titleKey: 'trace.artifacts',
      detail: artifacts.map(item => item.path).join(', '),
      ...(artifacts[0] ? { artifact: artifacts[0] } : {}),
    },
    artifacts,
  }
}

function eventFields(event, { task, calls, redactText }) {
  const data = event.data ?? {}
  if (event.type === 'user/message' || event.type === 'assistant/message') return { fields: messageFields(event.type, data, task, redactText) }
  if (event.type === 'tool/call') return { fields: toolCallFields(data, calls, redactText) }
  if (event.type === 'tool/result') return { fields: toolResultFields(data, calls, redactText) }
  if (event.type === 'deliverables/presented') return artifactFields(data, redactText)
  return undefined
}

function evidenceIdFor(type, id, trust) {
  if (type === 'assistant/message' || type === 'tool/result') return `${id}:${trust}`
  if (type === 'deliverables/presented') return `${id}:artifact`
  return null
}

function hasEvidence(fields) {
  return fields.detail !== '' || fields.artifact !== undefined || fields.command !== undefined || fields.diff !== undefined
}

function traceEvidenceFor(record, fields) {
  const relatedEvidenceId = record.relatedEvidenceId
  if (relatedEvidenceId === null || !hasEvidence(fields)) return undefined
  return {
    id: relatedEvidenceId,
    trust: record.trust,
    titleKey: record.titleKey,
    ...(record.toolName ? { toolName: record.toolName } : {}),
    ...(record.resultKey ? { resultKey: record.resultKey } : {}),
    text: record.detail,
    ...(record.requestDetail ? { requestDetail: record.requestDetail } : {}),
    at: record.at,
    sourceId: `${record.sessionId}:${record.seq}`,
    ...(record.command ? { command: record.command } : {}),
    ...(record.diff ? { diff: record.diff } : {}),
    artifact: record.artifact ?? null,
  }
}

function recordAt(event, sessionId, currentTurn, task, index, fields) {
  const seq = Number.isInteger(event.seq) ? event.seq : null
  const id = `trace:${sessionId}:${seq ?? index + 1}`
  const record = {
    id,
    type: event.type,
    trust: fields.trust,
    titleKey: fields.titleKey,
    ...(fields.toolName ? { toolName: fields.toolName } : {}),
    ...(fields.resultKey ? { resultKey: fields.resultKey } : {}),
    detail: fields.detail,
    ...(fields.requestDetail ? { requestDetail: fields.requestDetail } : {}),
    ...(fields.command ? { command: fields.command } : {}),
    ...(fields.diff ? { diff: fields.diff } : {}),
    at: timeOf(event.time),
    turn: currentTurn,
    actor: fields.actor ?? null,
    sessionId,
    seq,
    sourceTaskId: task.id,
    sourceId: task.sourceId,
    relatedEvidenceId: evidenceIdFor(event.type, id, fields.trust),
    ...(fields.artifact ? { artifact: fields.artifact } : {}),
  }
  return record
}

export function traceFor({ records, task, raw, redactText }) {
  const traceRecords = []
  const traceEvidence = []
  const artifacts = []
  const sessionIds = []
  const calls = new Map()
  let truncated = false
  for (const page of Array.isArray(records) ? records : []) {
    if (!page || typeof page !== 'object' || !Array.isArray(page.events)) continue
    const sessionId = text(page.sessionId)
    if (!sessionId) continue
    if (page.hasMore === true) truncated = true
    const turns = matchedTurns(page.events, task, raw)
    if (turns.size === 0) continue
    sessionIds.push(sessionId)
    let currentTurn
    for (const [index, event] of page.events.entries()) {
      currentTurn = turnOf(event, currentTurn)
      if (!Number.isInteger(currentTurn) || !turns.has(currentTurn)) continue
      const normalized = eventFields(event, { task, calls, redactText })
      if (normalized === undefined) continue
      const record = recordAt(event, sessionId, currentTurn, task, index, normalized.fields)
      traceRecords.push(record)
      const evidence = traceEvidenceFor(record, normalized.fields)
      if (evidence !== undefined) traceEvidence.push(evidence)
      for (const artifact of normalized.artifacts ?? []) artifacts.push({ ...artifact, at: record.at, sourceId: `${record.id}:artifact` })
    }
  }
  return {
    trace: {
      status: traceRecords.length > 0 ? 'ready' : 'empty',
      sourceTaskId: task.id,
      sourceId: task.sourceId,
      sessionIds,
      relationships: [
        { from: task.sourceId, to: task.sourceId, kind: 'task-source', labelKey: 'trace.source' },
        ...sessionIds.map(sessionId => ({ from: task.sourceId, to: sessionId, kind: 'task-session', labelKey: 'trace.session' })),
        ...sessionIds.map(sessionId => ({ from: sessionId, to: task.id, kind: 'session-task', labelKey: 'trace.task' })),
      ],
      timeline: traceRecords,
      records: traceRecords,
      truncated,
    },
    evidence: traceEvidence,
    artifacts,
  }
}
