// A selected-task read projection over the goal task or open work DS Bot already keeps.
// Session records are supplied by the channel; this module only joins and labels them.
import { isLiveDataMode, resolveDataMode } from '../shared/data-mode.js'
import { evidenceForRecord, normalizeEvidenceTrust, projectTaskVerification } from './task-verification.js'
import { traceFor } from './task-trace.js'

const text = value => (value === undefined || value === null ? '' : String(value))
const timeOf = value => {
  const time = typeof value === 'number' ? value : Date.parse(text(value))
  return Number.isFinite(time) ? time : null
}
const latestTime = (values) => {
  const times = values.map(timeOf).filter(value => value !== null)
  return times.length === 0 ? null : Math.max(...times)
}

export const redactCredentialText = (value) => {
  let output = text(value)
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
  output = output.replace(/\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
  const key = '(?:(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|password|passwd|pwd|token|secret|authorization|credential|key))'
  output = output.replace(new RegExp(`("?${key}"?\\s*:\\s*)"[^"]*"`, 'gi'), '$1"[redacted]"')
  output = output.replace(new RegExp(`\\b(${key})\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'), '$1=[redacted]')
  return output
}

const redactText = value => redactCredentialText(value).slice(0, 1200)


function goalRecord(state, sourceId) {
  for (const room of Object.values(state?.rooms ?? {})) {
    for (const goal of [room?.goal, ...(Array.isArray(room?.pastGoals) ? room.pastGoals : [])]) {
      if (!goal || typeof goal !== 'object') continue
      for (const [stageIndex, stage] of (Array.isArray(goal.stages) ? goal.stages : []).entries()) {
        for (const task of Array.isArray(stage?.tasks) ? stage.tasks : []) {
          const id = `goal:${text(goal.id)}:${text(stage.id)}:${text(task.id)}`
          if (id === sourceId) return { room, goal, stage, task, stageIndex }
        }
      }
    }
  }
  return undefined
}

function workRecord(state, sourceId) {
  const id = sourceId.startsWith('handoff:') ? sourceId.slice('handoff:'.length) : sourceId
  const work = state?.works?.[id]
  return work && typeof work === 'object' ? { id, work, room: state?.rooms?.[work.room] } : undefined
}

function handoffsFor(state, task) {
  if (task?.source !== 'goal') return []
  return Object.entries(state?.works ?? {}).flatMap(([id, work]) => {
    if (work?.goalTask?.taskId !== task.sourceId) return []
    const ownerId = text(work.to) || null
    const open = Array.isArray(work.open) ? work.open.length : 0
    return [{
      id: `handoff:${id}`,
      parentId: task.id,
      goalTaskId: task.sourceId,
      goalTaskAttemptId: text(work.goalTask.attemptId) || null,
      title: redactText(work.name) || `Handoff to ${text(state?.bots?.[ownerId]?.name) || ownerId || 'a Bot'}`,
      status: open > 0 ? 'waiting' : 'active',
      owner: text(state?.bots?.[ownerId]?.name) || ownerId || '',
      from: { id: text(work.from) || null, name: redactText(state?.bots?.[work.from]?.name ?? work.from) },
      to: { id: ownerId, name: redactText(state?.bots?.[ownerId]?.name ?? ownerId) },
      updatedAt: latestTime([
        work.at,
        work.attempt?.updatedAt,
        work.checkpoint?.at,
        ...(Array.isArray(work.evidence) ? work.evidence.map(item => item?.at) : []),
      ]),
    }]
  }).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
}

function artifactsFor(raw, evidence) {
  const artifacts = []
  for (const item of Array.isArray(raw?.task?.artifacts) ? raw.task.artifacts : []) {
    if (!item || typeof item !== 'object') continue
    artifacts.push({
      path: text(item.path),
      name: text(item.name) || text(item.path).split(/[\\/]/).pop(),
      digest: text(item.digest) || null,
      at: timeOf(item.at),
      sourceId: text(item.sourceId) || null,
      trust: ['reported', 'executed', 'verified'].includes(text(item.trust ?? item.kind)) ? text(item.trust ?? item.kind) : 'executed',
    })
  }
  for (const item of evidence) {
    if (!item.artifact?.path) continue
    artifacts.push({ ...item.artifact, at: item.at, sourceId: item.sourceId, trust: item.trust })
  }
  return artifacts
}

function mergedArtifacts(items) {
  const rank = { reported: 0, executed: 1, verified: 2 }
  const byKey = new Map()
  for (const item of items) {
    if (!item?.path) continue
    const key = `${item.path}\u0000${item.digest ?? ''}`
    const previous = byKey.get(key)
    if (previous === undefined || rank[item.trust] > rank[previous.trust]) byKey.set(key, item)
  }
  return [...byKey.values()]
}

function locationFor(activityTask, raw) {
  if (activityTask.source === 'goal') {
    return {
      roomId: activityTask.roomId,
      roomName: activityTask.roomName,
      goalId: text(raw?.goal?.id) || null,
      goalTitle: text(raw?.goal?.title),
      goalStatus: text(raw?.goal?.status) || null,
      stageId: text(raw?.stage?.id) || activityTask.stageId,
      stageTitle: activityTask.stageTitle,
      stageIndex: raw?.stageIndex ?? null,
      stageCount: Array.isArray(raw?.goal?.stages) ? raw.goal.stages.length : null,
    }
  }
  return {
    roomId: activityTask.roomId,
    roomName: activityTask.roomName,
    goalId: null,
    goalTitle: '',
    goalStatus: null,
    stageId: null,
    stageTitle: '',
    stageIndex: null,
    stageCount: null,
  }
}

function checkpointFor(raw, activityTask) {
  const checkpoint = raw?.task?.checkpoint ?? raw?.work?.checkpoint
  if (typeof checkpoint === 'string' && checkpoint !== '') return { text: checkpoint, at: null, kind: 'reported' }
  if (checkpoint && typeof checkpoint === 'object') {
    return { text: redactText(checkpoint.text ?? checkpoint.summary), at: timeOf(checkpoint.at ?? checkpoint.time), kind: text(checkpoint.kind) || 'reported' }
  }
  const event = [...(Array.isArray(raw?.goal?.events) ? raw.goal.events : [])]
    .filter(item => item?.stage === undefined || item.stage === raw?.stage?.id)
    .sort((a, b) => (timeOf(b.at) ?? 0) - (timeOf(a.at) ?? 0))[0]
  if (event !== undefined) return { text: redactText(event.text) || text(event.kind), at: timeOf(event.at), kind: text(event.kind) || 'reported' }
  const note = text(raw?.task?.note ?? raw?.work?.held)
  return note === '' ? null : { text: redactText(note), at: activityTask.updatedAt ?? null, kind: 'reported' }
}

function nextActionFor(raw, activityTask) {
  const next = raw?.task?.nextAction ?? raw?.work?.nextAction
  const value = next && typeof next === 'object' ? next.text : next
  if (value !== undefined && text(value).trim() !== '') return { text: redactText(value), sourceId: activityTask.sourceId }
  if (activityTask.sourceStatus === 'done' && activityTask.acceptance) {
    return { text: `Provide acceptance verification for: ${activityTask.acceptance}`, sourceId: activityTask.sourceId }
  }
  if (activityTask.source === 'goal' && ['pending', 'working'].includes(activityTask.sourceStatus) && activityTask.title) {
    return { text: activityTask.title, sourceId: activityTask.sourceId }
  }
  if (activityTask.source === 'handoff') {
    return { text: activityTask.ownerName ? `Wait for ${activityTask.ownerName} to return.` : 'Wait for the handoff to return.', sourceId: activityTask.sourceId }
  }
  return null
}

function controlsFor({ state, raw, task, liveSessionIds, readOnly }) {
  const controls = []
  const locked = text(readOnly).trim()
  const live = new Set(Array.isArray(liveSessionIds) ? liveSessionIds.map(text) : [])
  const add = (control) => {
    controls.push({ ...control, enabled: locked === '', ...(locked === '' ? {} : { reason: locked }) })
  }
  const botId = text(task.ownerId)
  const roomId = text(task.roomId)
  const blocked = botId !== '' && state?.bots?.[botId]?.blocked && typeof state.bots[botId].blocked === 'object'
  if (task.source === 'goal') {
    const goal = raw?.goal
    if (goal?.status === 'active') add({ id: 'pause-goal', roomId, goalId: text(goal.id) })
    if (goal?.status === 'paused') add({ id: 'resume-goal', roomId, goalId: text(goal.id) })
    if (['drafting', 'active', 'paused'].includes(goal?.status)) add({ id: 'stop-goal', roomId, goalId: text(goal.id) })
  }
  if (blocked) add({ id: 'retry-bot', botId })
  if (task.source === 'handoff') {
    const workId = text(raw?.id)
    const parent = state?.works?.[raw?.work?.parent]
    if (raw?.work?.parent !== undefined && Array.isArray(parent?.open) && parent.open.includes(workId)) {
      add({ id: 'abandon-work', workId })
    }
  }
  const memberSession = text(raw?.room?.sessions?.[botId])
  const ownSession = text(state?.bots?.[botId]?.sessionId)
  const roomSession = text(raw?.room?.sessionId ?? raw?.room?.id)
  if (task.ownerKind === 'group' && roomId !== '' && live.has(roomSession)) add({ id: 'cancel-room', roomId })
  if (botId !== '' && (live.has(memberSession) || (task.source === 'handoff' && live.has(ownSession)))) {
    add({ id: 'cancel-work', roomId: roomId || null, botId })
  }
  return controls
}

export function taskSessionIds({ state, activity, taskId } = {}) {
  const task = (activity?.tasks ?? []).find(item => item.id === taskId)
  if (task === undefined) return []
  const raw = task.source === 'goal' ? goalRecord(state, task.sourceId) : workRecord(state, task.sourceId)
  const ids = []
  const add = (value) => {
    const id = text(value)
    if (id !== '' && !ids.includes(id)) ids.push(id)
  }
  add(raw?.task?.attempt?.sessionId ?? raw?.work?.attempt?.sessionId)
  add(raw?.task?.checkpoint?.sessionId ?? raw?.work?.checkpoint?.sessionId)
  if (task.source === 'goal') {
    add(raw?.room?.sessions?.[task.ownerId])
    add(raw?.room?.sessionId ?? raw?.room?.id)
    add(state?.bots?.[task.ownerId]?.sessionId)
  } else {
    add(raw?.room?.sessions?.[raw?.work?.to])
    add(state?.bots?.[raw?.work?.to]?.sessionId)
    add(state?.bots?.[raw?.work?.from]?.sessionId)
  }
  return ids.slice(0, 4)
}

function attemptFor(raw) {
  const attempt = raw?.task?.attempt ?? raw?.work?.attempt
  if (!attempt || typeof attempt !== 'object') return null
  return {
    id: text(attempt.id),
    number: Number.isInteger(attempt.n) ? attempt.n : null,
    status: text(attempt.status) || 'unknown',
    startedAt: timeOf(attempt.startedAt),
    updatedAt: timeOf(attempt.updatedAt),
    ...(text(attempt.sessionId) ? { sessionId: text(attempt.sessionId) } : {}),
    ...(text(attempt.exchangeId) ? { exchangeId: text(attempt.exchangeId) } : {}),
    ...(Number.isInteger(attempt.turn) ? { turn: attempt.turn } : {}),
  }
}

function handoffFor(raw, state) {
  const ids = raw?.work ?? raw?.task?.handoff
  if (!ids || typeof ids !== 'object') return null
  const fromId = text(ids.from)
  const toId = text(ids.to)
  const open = Array.isArray(ids.open) ? ids.open.length : Number.isInteger(ids.open) ? ids.open : 0
  const results = Array.isArray(ids.results) ? ids.results.length : Number.isInteger(ids.results) ? ids.results : 0
  return {
    id: text(raw?.work ? raw.id : ids.id),
    parentId: text(ids.parent) || null,
    name: redactText(ids.name),
    status: text(ids.status) || (open > 0 ? 'waiting' : 'active'),
    from: { id: fromId || null, name: redactText(state?.bots?.[fromId]?.name ?? ids.fromName) },
    to: { id: toId || null, name: redactText(state?.bots?.[toId]?.name ?? ids.toName) },
    open,
    results,
  }
}

function recoveryFor(raw) {
  const declared = raw?.task?.recovery ?? raw?.work?.recovery
  const records = (Array.isArray(declared) ? declared : []).filter(item => item && typeof item === 'object').map(item => ({
    id: text(item.id),
    at: timeOf(item.at ?? item.time),
    attemptId: text(item.attemptId) || null,
    kind: text(item.kind) || 'recovery',
    summary: redactText(item.summary ?? item.text),
    ...(text(item.sessionId) ? { sessionId: text(item.sessionId) } : {}),
  }))
  if (records.length === 0 && raw?.work?.late === true) records.push({
    id: `${text(raw.id)}:late`, at: null, attemptId: text(raw.work.attempt?.id) || null,
    kind: 'late', summary: 'This request reached its owner only after a restart.',
  })
  return { state: records.length === 0 ? 'none' : records.some(item => item.kind === 'needs-review') ? 'needs-review' : 'recovered', records }
}

function blockersFor(raw, task) {
  const blockers = []
  for (const warning of Array.isArray(task.warnings) ? task.warnings : []) {
    if (/missing owner/i.test(text(warning))) blockers.push({ id: `owner:${task.id}`, kind: 'owner', text: text(warning) })
  }
  const declared = raw?.task?.blockers ?? raw?.work?.blockers
  if (Array.isArray(declared)) {
    for (const [index, item] of declared.entries()) {
      const value = item && typeof item === 'object' ? item : { text: item }
      blockers.push({ id: text(value.id) || `${task.id}:blocker:${index}`, kind: text(value.kind) || 'reported', text: redactText(value.text ?? value.summary) })
    }
  }
  const recovery = raw?.task?.recovery ?? raw?.work?.recovery
  for (const item of Array.isArray(recovery) ? recovery : []) {
    if (item?.kind === 'needs-review') blockers.push({ id: text(item.id) || `${task.id}:recovery`, kind: 'recovery', text: redactText(item.summary) })
  }
  for (const childId of Array.isArray(raw?.work?.open) ? raw.work.open : []) {
    blockers.push({ id: `${task.id}:wait:${text(childId)}`, kind: 'wait', text: `Waiting for ${text(childId)} to return.` })
  }
  for (const result of Array.isArray(raw?.work?.results) ? raw.work.results : []) {
    if (result?.failed === true) blockers.push({ id: `${task.id}:failed:${text(result.id)}`, kind: 'failed-result', text: `${text(result.name) || text(result.id)} failed to deliver its result.` })
    if (result?.abandoned === true) blockers.push({ id: `${task.id}:abandoned:${text(result.id)}`, kind: 'recovery', text: `${text(result.name) || text(result.id)} was abandoned; continue without that answer.` })
  }
  if (raw?.work?.late === true) blockers.push({ id: `${task.id}:late`, kind: 'recovery', text: 'This request reached its owner only after a restart.' })
  return blockers
}

// The normalizers above stay private: this projection is their only consumer, and
// splitting them would make the detail response contract harder to follow.
export function buildTaskDetail({ state, activity, taskId, records = [], sourceWarnings = [], liveSessionIds = [], readOnly, now = Date.now() } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const dataMode = resolveDataMode(activity)
  const activityTask = (activity?.tasks ?? []).find(task => task.id === taskId)
  if (activityTask === undefined) {
    return {
      schema: 1, dataMode, generatedAt: at, taskId, task: null, empty: true,
      evidence: [], artifacts: [], handoffs: [], blockers: [], controls: [],
      verification: { status: 'unavailable', reason: 'The selected task is no longer present.' },
      trace: { status: 'empty', sourceTaskId: taskId, sourceId: taskId, sessionIds: [], relationships: [], timeline: [], records: [], truncated: false },
      partial: false, warnings: [],
    }
  }
  const raw = activityTask.source === 'goal' ? goalRecord(state, activityTask.sourceId) : workRecord(state, activityTask.sourceId)
  const traceParts = traceFor({ records, task: activityTask, raw, redactText })
  const sourceEvidence = evidenceForRecord(raw, activityTask.id, redactText)
  const projected = projectTaskVerification(raw, sourceEvidence)
  const evidence = normalizeEvidenceTrust([...projected.evidence, ...traceParts.evidence], projected.verification)
  const nonLive = !isLiveDataMode(dataMode)
  const nonLiveReason = dataMode === 'preview' ? 'Preview data is not verification.'
    : dataMode === 'demo' ? 'Demo data is not verification.'
      : 'Data mode is unavailable, so verification cannot be trusted.'
  const verification = nonLive ? { status: 'unavailable', reason: nonLiveReason } : projected.verification
  const artifacts = mergedArtifacts([...artifactsFor(raw, evidence), ...traceParts.artifacts])
  const blockers = blockersFor(raw, activityTask)
  const recovery = recoveryFor(raw)
  const recoveryNeeded = recovery.state === 'needs-review'
  const hasSourceWarning = Array.isArray(sourceWarnings) && sourceWarnings.length > 0
  const trace = hasSourceWarning || recoveryNeeded ? { ...traceParts.trace, status: 'partial' } : traceParts.trace
  const controls = controlsFor({ state, raw, task: activityTask, liveSessionIds, readOnly }).map(control => nonLive
    ? { ...control, enabled: false, reason: 'Non-live data is read-only.' }
    : control)
  const safeTask = {
    ...activityTask,
    title: redactText(activityTask.title),
    subtitle: redactText(activityTask.subtitle),
    stageTitle: redactText(activityTask.stageTitle),
    roomName: redactText(activityTask.roomName),
    acceptance: redactText(activityTask.acceptance),
    evidence: typeof activityTask.evidence === 'string' ? redactText(activityTask.evidence) : activityTask.evidence,
    note: redactText(activityTask.note),
  }
  return {
    schema: 1,
    dataMode,
    generatedAt: at,
    taskId,
    task: safeTask,
    empty: false,
    owner: {
      id: activityTask.ownerId,
      name: activityTask.ownerName,
      role: activityTask.ownerRole,
      kind: activityTask.ownerKind,
      main: activityTask.ownerMain === true,
      missing: activityTask.ownerKind === 'unknown',
    },
    location: locationFor(activityTask, raw),
    attempt: attemptFor(raw),
    handoff: handoffFor(raw, state),
    recovery,
    checkpoint: checkpointFor(raw, activityTask),
    nextAction: nextActionFor(raw, activityTask),
    blockers,
    evidence,
    evidenceState: projected.evidenceState,
    artifacts,
    handoffs: handoffsFor(state, activityTask),
    verification,
    trace,
    controls,
    partial: hasSourceWarning || activityTask.warnings?.length > 0 || recoveryNeeded,
    warnings: [
      ...(Array.isArray(sourceWarnings) ? sourceWarnings : []).map(message => ({ taskId, message: redactText(message) })),
      ...(Array.isArray(activityTask.warnings) ? activityTask.warnings : []).map(message => ({ taskId, message: redactText(message) })),
    ],
  }
}
