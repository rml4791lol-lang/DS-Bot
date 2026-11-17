// A read-only projection over the task-like records DS Bot already keeps: goal tasks,
// open handoffs, the team-board archive, and the task ledger. It never writes state or
// promotes prose into completion; sourceStatus stays the owner's own value.
import { taskDay } from './task-ledger.js'
import { evidenceForRecord, projectTaskVerification } from './task-verification.js'

const HOUR_MS = 60 * 60 * 1000
const ACTIVITY_DAYS = 7
const ACTIVE_STATUS = new Set(['working', 'active'])
const WAITING_STATUS = new Set(['waiting', 'pending', 'paused'])
const ATTENTION_STATUS = new Set(['reported', 'blocked', 'failed', 'unknown'])
const ATTENTION_FILTER = [...new Set([...WAITING_STATUS, ...ATTENTION_STATUS])]

const text = value => (value === undefined || value === null ? '' : String(value))
const displayStateOf = status => status === 'waiting' ? 'waiting' : ACTIVE_STATUS.has(status) ? 'working' : ATTENTION_STATUS.has(status) ? 'alert' : 'idle'
const timeOf = value => {
  const time = Date.parse(text(value))
  return Number.isFinite(time) ? time : undefined
}
const timestampOf = value => Number.isFinite(value) ? value : timeOf(value)
const latestTimestamp = (values) => {
  const times = values.map(timestampOf).filter(Number.isFinite)
  return times.length === 0 ? undefined : Math.max(...times)
}

export function activityDays(at = Date.now(), timeZone) {
  const when = Number.isFinite(at) ? at : Date.now()
  const days = []
  let cursor = when
  while (days.length < ACTIVITY_DAYS) {
    const day = taskDay(cursor, timeZone)
    if (!days.includes(day)) days.unshift(day)
    cursor -= HOUR_MS
  }
  return days
}

function rolesFor(bots, mainIds) {
  return Object.entries(bots).filter(([, bot]) => bot && typeof bot === 'object').map(([key, bot]) => {
    const id = text(bot.id) || text(key)
    const main = mainIds.has(id)
    return {
      id,
      name: text(bot.name) || id,
      role: text(bot.role),
      color: text(bot.color),
      avatar: bot.avatar && typeof bot.avatar === 'object' ? bot.avatar : undefined,
      sectionId: text(bot.sectionId) || null,
      main,
      permission: main ? 'Main Bot' : 'Member',
    }
  })
}

function boardActivityFor(board, { at, timeZone, daySet, byName, botName, botRole }) {
  const activity = []
  const warnings = []
  for (const line of Array.isArray(board) ? board : []) {
    if (!line || typeof line !== 'object') continue
    const when = timeOf(line.at)
    if (when === undefined) {
      warnings.push('team board activity: skipped a row without a valid time')
      continue
    }
    if (when > at || !daySet.has(taskDay(when, timeZone))) continue
    const bot = byName.get(text(line.bot))
    activity.push({
      id: `board:${text(line.bot)}:${when}:${text(line.kind)}:${text(line.what)}`,
      source: 'board',
      kind: text(line.kind) || 'delivery',
      text: text(line.what),
      botId: text(bot?.id) || null,
      botName: text(line.bot) || botName(bot?.id),
      role: botRole(bot?.id),
      evidence: text(line.evidence) || null,
      needs: text(line.needs) || null,
      at: when,
    })
  }
  return { activity, warnings }
}

function ledgerActivityFor(ledger, { at, timeZone, daySet, botName, botRole }) {
  const activity = []
  for (const row of Array.isArray(ledger) ? ledger : []) {
    if (!row || typeof row !== 'object' || !Number.isFinite(row.time)) continue
    if (row.time > at || !daySet.has(taskDay(row.time, timeZone))) continue
    const kind = row.kind === 'close' ? 'closed' : 'opened'
    const outcome = row.kind === 'close' && row.outcome ? ` (${text(row.outcome)})` : ''
    activity.push({
      id: `ledger:${text(row.id)}:${text(row.kind)}:${row.time}`,
      source: 'ledger',
      kind,
      text: `Work ${text(row.id)} ${kind}${outcome}`,
      botId: text(row.to ?? row.from) || null,
      botName: botName(row.to ?? row.from),
      role: botRole(row.to ?? row.from),
      evidence: null,
      needs: null,
      at: row.time,
    })
  }
  return activity
}

function sourceActivityFor(board, ledger, context) {
  const boardResult = boardActivityFor(board, context)
  return {
    activity: [...boardResult.activity, ...ledgerActivityFor(ledger, context)].sort((a, b) => b.at - a.at),
    warnings: boardResult.warnings,
  }
}

function goalTasksFor({ rooms, bots, mainIds, botName, botRole }) {
  const tasks = []
  for (const room of Object.values(rooms)) {
    const goal = room?.goal
    if (!goal || typeof goal !== 'object') continue
    for (const stage of Array.isArray(goal.stages) ? goal.stages : []) {
      for (const task of Array.isArray(stage?.tasks) ? stage.tasks : []) {
        const id = `goal:${text(goal.id)}:${text(stage.id)}:${text(task.id)}`
        const ownerId = text(task?.botId)
        const ownStatus = text(task?.status)
        const stageStatus = text(stage?.status)
        const sourceStatus = ownStatus || stageStatus || 'pending'
        const raw = { goal, stage, task }
        const projected = projectTaskVerification(raw, evidenceForRecord(raw, id))
        tasks.push({
          id, sourceId: id, source: 'goal', kind: 'goal_task',
          title: text(task?.task), subtitle: text(goal.title), stageTitle: text(stage?.title), stageId: text(stage.id),
          parentId: `goal:${text(goal.id)}`,
          ownerId: ownerId || null,
          ownerName: bots[ownerId] ? botName(ownerId) : '',
          ownerKind: bots[ownerId] ? 'bot' : 'unknown',
          ownerRole: botRole(ownerId),
          ownerMain: mainIds.has(ownerId),
          roomId: text(room.id) || null,
          roomName: text(room.name),
          sourceStatus,
          displayState: displayStateOf(sourceStatus),
          statusSource: ownStatus ? 'goal.task' : stageStatus ? 'goal.stage' : 'default',
          evidenceState: projected.evidenceState,
          verification: projected.verification,
          acceptance: text(stage?.acceptance),
          evidence: text(stage?.evidence) || null,
          note: text(task?.note) || null,
          updatedAt: Number.isFinite(goal.updatedAt) ? goal.updatedAt : null,
          warnings: ownerId && bots[ownerId] === undefined ? [`missing owner ${ownerId}`] : !ownerId ? ['missing owner'] : [],
        })
      }
    }
  }
  return tasks
}

function handoffTasksFor({ works, rooms, bots, mainIds, botName, botRole }) {
  const tasks = []
  for (const [id, work] of Object.entries(works)) {
    if (!work || typeof work !== 'object') continue
    const waiting = Array.isArray(work.open) && work.open.length > 0
    const sourceStatus = waiting ? 'waiting' : 'active'
    const ownerId = text(work.to)
    const roomId = text(work.room)
    const roomName = text(rooms[roomId]?.name)
    const owner = ownerId ? bots[ownerId] : undefined
    const ownerName = owner ? botName(ownerId) : roomName
    const fromName = botName(work.from)
    const arrow = fromName && ownerName ? `${fromName} → ${ownerName}` : fromName || ownerName || text(id)
    const raw = { id, work }
    const projected = projectTaskVerification(raw, evidenceForRecord(raw, `handoff:${text(id)}`))
    tasks.push({
      id: `handoff:${text(id)}`, sourceId: `handoff:${text(id)}`, source: 'handoff', kind: 'handoff',
      title: text(work.name) || arrow, subtitle: '', stageTitle: '', stageId: null,
      parentId: text(work.goalTask?.taskId) || (work.parent ? `handoff:${text(work.parent)}` : null),
      goalTaskId: text(work.goalTask?.taskId) || null,
      goalTaskAttemptId: text(work.goalTask?.attemptId) || null,
      ownerId: ownerId || null,
      ownerName,
      ownerKind: owner ? 'bot' : roomName ? 'group' : 'unknown',
      ownerRole: botRole(ownerId),
      ownerMain: mainIds.has(ownerId),
      roomId: roomId || null,
      roomName: text(rooms[roomId]?.name),
      sourceStatus,
      displayState: displayStateOf(sourceStatus),
      statusSource: 'work.open',
      evidenceState: projected.evidenceState,
      verification: projected.verification,
      acceptance: '', evidence: null, note: text(work.held) || null,
      updatedAt: latestTimestamp([work.at, work.attempt?.updatedAt, work.checkpoint?.at, ...(Array.isArray(work.evidence) ? work.evidence.map(item => item?.at) : [])]) ?? null,
      warnings: ownerId && bots[ownerId] === undefined ? [`missing owner ${ownerId}`] : !ownerId && !roomName ? ['missing owner or group'] : [],
    })
  }
  return tasks
}

function warningsFor(sourceWarnings, projectionWarnings, tasks) {
  return [
    ...(Array.isArray(sourceWarnings) ? sourceWarnings : []).map(message => ({ taskId: null, message: text(message) })),
    ...projectionWarnings.map(message => ({ taskId: null, message })),
    ...tasks.flatMap(task => task.warnings.map(message => ({ taskId: task.id, message }))),
  ]
}

function summaryFor(tasks, activity) {
  return {
    active: tasks.filter(task => ACTIVE_STATUS.has(task.sourceStatus)).length,
    waiting: tasks.filter(task => WAITING_STATUS.has(task.sourceStatus)).length,
    attention: tasks.filter(task => ATTENTION_STATUS.has(task.sourceStatus)).length,
    reported: tasks.filter(task => task.sourceStatus === 'reported').length,
    verified: tasks.filter(task => task.evidenceState === 'verified').length,
    activity: activity.length,
  }
}

export function buildTeamActivity({ state, board = [], ledger = [], now = Date.now(), timeZone, sourceWarnings = [] } = {}) {
  const at = Number.isFinite(now) ? now : Date.now()
  const bots = state?.bots && typeof state.bots === 'object' ? state.bots : {}
  const rooms = state?.rooms && typeof state.rooms === 'object' ? state.rooms : {}
  const works = state?.works && typeof state.works === 'object' ? state.works : {}
  const mainIds = new Set(Array.isArray(state?.mainBotIds) ? state.mainBotIds : [])
  const botName = id => text(bots[id]?.name) || text(id)
  const botRole = id => text(bots[id]?.role)
  const byName = new Map(Object.values(bots).map(bot => [text(bot?.name), bot]))
  const roles = rolesFor(bots, mainIds)
  const days = activityDays(at, timeZone)
  const daySet = new Set(days)
  const source = sourceActivityFor(board, ledger, { at, timeZone, daySet, byName, botName, botRole })
  const tasks = [
    ...goalTasksFor({ rooms, bots, mainIds, botName, botRole }),
    ...handoffTasksFor({ works, rooms, bots, mainIds, botName, botRole }),
  ].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id))
  const statuses = [...new Set(tasks.map(task => task.sourceStatus))].sort()
  const warnings = warningsFor(sourceWarnings, source.warnings, tasks)
  return {
    schema: 1,
    dataMode: 'live',
    generatedAt: at,
    roles,
    tasks,
    activity: source.activity.slice(0, 100),
    heatmap: days.map(day => ({ day, count: source.activity.filter(item => taskDay(item.at, timeZone) === day).length })),
    filters: { sources: ['goal', 'handoff'], statuses, roles: roles.map(role => role.id), attentionStatuses: ATTENTION_FILTER },
    summary: summaryFor(tasks, source.activity),
    partial: warnings.length > 0,
    warnings,
  }
}
