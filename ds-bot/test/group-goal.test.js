import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { afterRound } from './relay-rows.js'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { ROOM_WORK_GRACE_MS } from '../src/host/constants.js'
import { buildTaskDetail } from '../src/host/task-detail.js'
import { buildTeamActivity } from '../src/host/team-activity.js'

// Chief, the admin of group 'r1', speaks there from 'ga'; Writer from 'gb'; Tester from 'gc'.
const seed = (room = {}, extraRooms = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b', 'c'], mode: 'admin', admin: 'a', named: true, sessions: { a: 'ga', b: 'gb', c: 'gc' }, log: [], seq: 0, seen: {}, ...room }, ...extraRooms },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room, services, extraRooms) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-goal-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room, extraRooms)))
  const ctx = fakeContext({ services })
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => message => { calls.push(message); list.push(message) }
      agents.set(sessionId, { session: { id: sessionId }, calls, cancelled, inbox, followup: keep(held), steer: keep(nextStep), cancel(reason) { cancelled.push(reason) } })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => (rt.teamTools.find(d => d.name === name) ?? ctx.registeredTools.get(name)).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const round = (callId, message) => {
    emit('r1', 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, 'r1', { callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, 'r1', value) })
    const read = () => result
    return read
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  // The next goal relay post the room's Session was sent, if any.
  const takeGoal = () => {
    const at = agentOf('r1').calls.findIndex(call => call.source?.role === 'goal')
    if (at === -1) return undefined
    const [post] = agentOf('r1').calls.splice(at, 1)
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, ctx, rt, agentOf, emit, tool, call, begin, finish, round, say, takePost, takeGoal }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const text = message => message.content.map(block => block.text ?? '').join('\n')
const saved = host => JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
const goal = host => saved(host).rooms.r1.goal
const logLines = host => saved(host).rooms.r1.log

const STAGES = [
  { title: 'Draft', acceptance: 'draft reviewed', tasks: [{ bot: 'Writer', task: 'write the draft' }] },
  { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
]
const CHECKED_STAGES = [{
  title: 'Check',
  acceptance: 'the test suite passes',
  checks: [{ id: 'tests', kind: 'command', label: 'test suite', command: 'npm test', expect: { exitCode: 0 } }],
  tasks: [{ bot: 'Writer', task: 'run the tests' }],
}]
const startGoal = (host, extra = {}) => host.tool('group_goal', {
  action: 'start', title: 'Ship it', objective: 'Ship the thing', acceptance: 'it is shipped', stages: STAGES, ...extra,
}, 'ga')

test('group_goal start validates the goal with the contract refusals', async (t) => {
  const host = await start(t)
  const run = args => host.tool('group_goal', args, 'ga')
  assert.equal(await run({ action: 'start', acceptance: 'ok', stages: STAGES }), 'objective is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', stages: STAGES }), 'acceptance is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a' }), 'stages is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [{ acceptance: 'x', tasks: [{ bot: 'Writer', task: 't' }] }] }), 'stage 1 title is required for start.')
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [{ title: 'S', acceptance: 'x', tasks: [{ bot: 'Nobody', task: 't' }] }] }), 'Nobody is not a member of "Ops". Members: Chief, Writer, Tester.')
  const many = { title: 'S', acceptance: 'x', tasks: Array.from({ length: 13 }, (_, i) => ({ bot: 'Writer', task: `t${i}` })) }
  assert.equal(await run({ action: 'start', objective: 'o', acceptance: 'a', stages: [many] }), 'At most 12 tasks in stage 1.')
  assert.equal(goal(host), undefined)
})

test('a goal starts, passes its stages, and completes', async (t) => {
  const host = await start(t)
  assert.match(await startGoal(host), /Started\. Hand out the tasks of stage 1 now/)
  const started = goal(host)
  assert.deepEqual([started.status, started.current, started.stages.map(stage => stage.status)], ['active', 0, ['active', 'pending']])
  assert.deepEqual(started.stages[0].tasks.map(task => task.status), ['pending'])
  assert.ok(logLines(host).some(line => line.reason === 'goal' && line.event === 'start' && line.title === 'Ship it'))

  assert.equal(await host.tool('group_goal', { action: 'pass' }, 'ga'), 'evidence is required for pass.')
  assert.equal(await host.tool('group_goal', { action: 'complete', evidence: 'e', summary: 's' }, 'ga'), 'Stage 1 "Draft" has not passed yet. Pass every stage before complete.')

  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'reviewed' }, 'ga'), /Stage 1 passed\. Stage 2 "Check" is current/)
  const second = goal(host)
  assert.deepEqual([second.current, second.stages.map(stage => stage.status)], [1, ['passed', 'active']])
  assert.equal(second.stages[0].tasks[0].status, 'done')
  assert.equal(second.stages[0].evidence, 'reviewed')

  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'green' }, 'ga'), /Every stage passed/)
  assert.equal(goal(host).current, 2)
  assert.equal(await host.tool('group_goal', { action: 'complete', summary: 's' }, 'ga'), 'evidence is required for complete.')
  assert.equal(await host.tool('group_goal', { action: 'complete', evidence: 'e' }, 'ga'), 'summary is required for complete.')
  assert.match(await host.tool('group_goal', { action: 'complete', evidence: 'all green', summary: 'shipped' }, 'ga'), /typed acceptance checks/i)
  assert.equal(goal(host).status, 'active')
  assert.equal(goal(host).stages[0].verification.manual, true)
  assert.equal(goal(host).stages[0].status, 'passed')
})

test('typed acceptance checks require matching executed evidence before a stage passes', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: CHECKED_STAGES })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'tool/call', { callId: 'test-1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) })
  host.emit('gb', 'tool/result', { callId: 'test-1', message: { ok: true, content: [{ type: 'text', text: '12 tests passed' }] } })

  assert.match(await host.tool('group_goal', { action: 'pass', evidence: 'Writer reported green' }, 'ga'), /Every stage passed/)
  const passed = goal(host)
  assert.equal(passed.stages[0].verification.state, 'verified')
  assert.equal(passed.stages[0].tasks[0].verification.state, 'verified')
  assert.equal(passed.stages[0].tasks[0].evidence[0].command.text, 'npm test')
  assert.equal(passed.stages[0].tasks[0].evidence[0].command.exitCode, 0)
  const state = saved(host)
  const activity = buildTeamActivity({ state, now: Date.now(), timeZone: 'Asia/Shanghai' })
  const taskId = `goal:${passed.id}:${passed.stages[0].id}:${passed.stages[0].tasks[0].id}`
  assert.equal(buildTaskDetail({ state, activity, taskId }).verification.status, 'verified')
})

test('a goal Bot handoff keeps its goal task binding in activity and task detail', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [STAGES[0]] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const before = goal(host)
  const goalTaskId = `goal:${before.id}:${before.stages[0].id}:${before.stages[0].tasks[0].id}`
  const attemptId = before.stages[0].tasks[0].attempt.id

  await host.tool('message_bot', { to: 'Tester', message: 'Review the draft before I report it.' }, 'b')
  const state = saved(host)
  const [workId, work] = Object.entries(state.works).find(([, item]) => item.from === 'b' && item.to === 'c')
  assert.deepEqual(work.goalTask, { taskId: goalTaskId, attemptId })
  assert.deepEqual([host.agentOf('c').calls.at(-1).source.taskId, host.agentOf('c').calls.at(-1).source.attemptId], [goalTaskId, attemptId])

  const activity = buildTeamActivity({ state, now: Date.now(), timeZone: 'Asia/Shanghai' })
  const handoff = activity.tasks.find(item => item.id === `handoff:${workId}`)
  assert.equal(handoff.parentId, goalTaskId)
  assert.equal(handoff.goalTaskId, goalTaskId)
  const detail = buildTaskDetail({ state, activity, taskId: goalTaskId, now: Date.now() })
  assert.deepEqual(detail.handoffs.map(item => [item.id, item.owner, item.status]), [[`handoff:${workId}`, 'Tester', 'active']])
})

test('message_bot waits for the handoff work record before it returns', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [STAGES[0]] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const original = host.rt.save.bind(host.rt)
  let entered = false
  let release
  const held = new Promise(resolve => { release = resolve })
  host.rt.save = async (...args) => {
    const handoff = Object.values(host.rt.state.works ?? {}).some(work => work.from === 'b' && work.to === 'c')
    if (handoff && !entered) {
      entered = true
      await held
    }
    return original(...args)
  }
  const deliver = host.rt.deliver.bind(host.rt)
  let delivered = false
  host.rt.deliver = async (...args) => {
    delivered = true
    return deliver(...args)
  }

  const sending = host.tool('message_bot', { to: 'Tester', message: 'Review it.' }, 'b')
  await settle(() => entered)
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(delivered, false, 'the request was delivered before the work record was durable')
  release()
  await sending
  assert.equal(delivered, true)
  assert.equal(Object.values(saved(host).works).some(work => work.from === 'b' && work.to === 'c'), true)
})

test('message_bot does not deliver when the handoff work cannot be saved', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [STAGES[0]] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const save = host.rt.save.bind(host.rt)
  host.rt.save = async (...args) => {
    const handoff = Object.values(host.rt.state.works ?? {}).some(work => work.from === 'b' && work.to === 'c')
    if (handoff) throw new Error('disk full')
    return save(...args)
  }
  const deliver = host.rt.deliver.bind(host.rt)
  let delivered = false
  host.rt.deliver = async (...args) => {
    delivered = true
    return deliver(...args)
  }

  await assert.rejects(() => host.tool('message_bot', { to: 'Tester', message: 'Review it.' }, 'b'), /disk full/)
  assert.equal(delivered, false)
  assert.equal(Object.values(host.rt.state.works ?? {}).some(work => work.from === 'b' && work.to === 'c'), false)
})

test('message_bot waits for a durable cleanup when delivery fails and the target is gone', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [STAGES[0]] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const botOf = host.rt.botOf.bind(host.rt)
  let targetGone = false
  host.rt.botOf = id => targetGone && id === 'c' ? undefined : botOf(id)
  host.rt.deliver = async () => {
    targetGone = true
    throw new Error('target gone')
  }
  const save = host.rt.save.bind(host.rt)
  let cleanupEntered = false
  let release
  const held = new Promise(resolve => { release = resolve })
  host.rt.save = async (...args) => {
    const orphan = targetGone && !Object.values(host.rt.state.works ?? {}).some(work => work.from === 'b' && work.to === 'c')
    if (orphan && !cleanupEntered) {
      cleanupEntered = true
      await held
    }
    return save(...args)
  }

  let settled = false
  const sending = host.tool('message_bot', { to: 'Tester', message: 'Review it.' }, 'b').then(
    () => { settled = true },
    error => { settled = true; return error },
  )
  await settle(() => cleanupEntered)
  for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'message_bot returned before the failed work was removed durably')
  release()
  assert.match((await sending).message, /target gone/)
  assert.equal(Object.values(saved(host).works).some(work => work.from === 'b' && work.to === 'c'), false)
})

test('message_bot reports a failed rollback instead of hiding it', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: [STAGES[0]] })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const botOf = host.rt.botOf.bind(host.rt)
  let targetGone = false
  host.rt.botOf = id => targetGone && id === 'c' ? undefined : botOf(id)
  host.rt.deliver = async () => {
    targetGone = true
    throw new Error('target gone')
  }
  const save = host.rt.save.bind(host.rt)
  host.rt.save = async (...args) => {
    const orphan = targetGone && !Object.values(host.rt.state.works ?? {}).some(work => work.from === 'b' && work.to === 'c')
    if (orphan) throw new Error('cleanup disk full')
    return save(...args)
  }

  await assert.rejects(
    () => host.tool('message_bot', { to: 'Tester', message: 'Review it.' }, 'b'),
    /work record could not be removed: cleanup disk full/,
  )
})

test('typed acceptance checks refuse prose and report the missing check', async (t) => {
  const host = await start(t)
  await startGoal(host, { stages: CHECKED_STAGES })
  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'I ran npm test and it passed.' }] } })
  assert.equal(await host.tool('group_goal', { action: 'pass', evidence: 'I ran npm test and it passed.' }, 'ga'),
    'Acceptance checks are not verified: tests. Supply matching command, artifact, or diff evidence.')
  assert.equal(goal(host).stages[0].status, 'active')
  const verification = goal(host).stages[0].verification
  assert.equal(verification.state, 'pending')
  assert.deepEqual(verification.checkEvidence, {})
  assert.deepEqual(verification.missing, ['tests'])
})

test('typed acceptance checks only accept command, artifact, and diff kinds', async (t) => {
  const host = await start(t)
  const run = args => host.tool('group_goal', args, 'ga')
  for (const kind of ['review', 'manual']) {
    await assert.rejects(run({
      action: 'start', objective: 'o', acceptance: 'a',
      stages: [{ title: 'S', acceptance: 'a', checks: [{ id: kind, kind }], tasks: [{ bot: 'Writer', task: 't' }] }],
    }), error => error?.code === 'INVALID_ARGS' && /must be one of \["command","artifact","diff"\]/.test(error.message))
  }
  assert.equal(goal(host), undefined)
  const tool = host.rt.teamTools.find(item => item.name === 'group_goal')
  const enums = [
    tool.parameters.properties.checks.items.properties.kind.enum,
    tool.parameters.properties.stages.items.properties.checks.items.properties.kind.enum,
    tool.parameters.properties.stages.items.properties.tasks.items.properties.checks.items.properties.kind.enum,
  ]
  assert.deepEqual(enums, Array(3).fill(['command', 'artifact', 'diff']))
  assert.doesNotMatch(JSON.stringify(tool.parameters), /independent review|manual is never/)
})

test('goal-level acceptance checks gate complete with executed evidence', async (t) => {
  const host = await start(t)
  await startGoal(host, {
    checks: [{ id: 'overall', kind: 'command', label: 'end-to-end tests', command: 'npm run e2e', expect: { exitCode: 0 } }],
    stages: [{ ...STAGES[0], checks: [{ id: 'stage-e2e', kind: 'command', command: 'npm run e2e', expect: { exitCode: 0 } }] }],
  })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'tool/call', { callId: 'e2e', name: 'pwsh', arguments: JSON.stringify({ command: 'npm run e2e' }) })
  host.emit('gb', 'tool/result', { callId: 'e2e', message: { ok: true, content: [{ type: 'text', text: 'e2e green' }] } })
  await host.tool('group_goal', { action: 'pass', evidence: 'draft reviewed' }, 'ga')
  assert.match(await host.tool('group_goal', { action: 'complete', evidence: 'reported done', summary: 'shipped' }, 'ga'), /Complete/)
  assert.equal(goal(host).verification.state, 'verified')
  assert.deepEqual(goal(host).verification.evidenceIds, ['ev:tool-result:gb:e2e'])
})

test('changing a verified artifact invalidates acceptance and reopens the goal', async (t) => {
  const host = await start(t)
  await startGoal(host, {
    stages: [{
      title: 'Package',
      acceptance: 'the package is current',
      checks: [{ id: 'package', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:first' } }],
      tasks: [{ bot: 'Writer', task: 'build the package' }],
    }],
  })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: 'sha256:first' }] })
  await host.tool('group_goal', { action: 'pass', evidence: 'package verified' }, 'ga')
  await host.tool('group_goal', { action: 'complete', evidence: 'all stages verified', summary: 'shipped' }, 'ga')

  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: 'sha256:changed' }] })
  await settle(() => goal(host).status === 'needs-review')
  const reopened = goal(host)
  assert.equal(reopened.status, 'needs-review')
  assert.equal(reopened.stages[0].status, 'active')
  assert.equal(reopened.stages[0].tasks[0].verification.state, 'stale')
})

test('a deleted or unhashable artifact invalidates verified acceptance', async (t) => {
  const host = await start(t)
  await startGoal(host, {
    stages: [{
      title: 'Package',
      acceptance: 'the package is current',
      checks: [{ id: 'package', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:first' } }],
      tasks: [{ bot: 'Writer', task: 'build the package' }],
    }],
  })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: 'sha256:first' }] })
  await host.tool('group_goal', { action: 'pass', evidence: 'package verified' }, 'ga')
  await host.tool('group_goal', { action: 'complete', evidence: 'all stages verified', summary: 'shipped' }, 'ga')

  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: '' }] })
  await settle(() => goal(host).status === 'needs-review')
  assert.equal(goal(host).stages[0].tasks[0].verification.state, 'stale')
  assert.deepEqual(goal(host).stages[0].tasks[0].verification.invalidated, ['dist/app.zip'])
})

test('changing a goal-level verified artifact also reopens completed work', async (t) => {
  const host = await start(t)
  await startGoal(host, {
    checks: [{ id: 'overall-package', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:first' } }],
    stages: [{ ...STAGES[0], checks: [{ id: 'stage-package', kind: 'artifact', path: 'dist/app.zip', expect: { digest: 'sha256:first' } }] }],
  })
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: 'sha256:first' }] })
  await host.tool('group_goal', { action: 'pass', evidence: 'draft reviewed' }, 'ga')
  await host.tool('group_goal', { action: 'complete', evidence: 'verified', summary: 'shipped' }, 'ga')
  assert.equal(goal(host).verification.state, 'verified')

  host.emit('gb', 'deliverables/presented', { files: [{ path: 'dist/app.zip', digest: 'sha256:changed' }] })
  await settle(() => goal(host).status === 'needs-review')
  assert.equal(goal(host).verification.state, 'stale')
})

test('two completed turns with only prose mark the goal task stalled', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  for (const reply of ['I am checking it.', 'It still looks good.']) {
    host.emit('gb', 'turn/start', { turn: 1 })
    host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    host.emit('gb', 'turn/end', { reason: { kind: 'completed' } })
  }
  await settle(() => goal(host).stages[0].tasks[0].progress.state === 'stalled')
  const task = goal(host).stages[0].tasks[0]
  assert.equal(task.progress.state, 'stalled')
  assert.equal(task.verification.state, 'needs-review')
  assert.match(task.checkpoint.summary, /No measurable progress/)
  const state = saved(host)
  const activity = buildTeamActivity({ state, now: Date.now(), timeZone: 'Asia/Shanghai' })
  const taskId = `goal:${state.rooms.r1.goal.id}:${state.rooms.r1.goal.stages[0].id}:${task.id}`
  assert.equal(buildTaskDetail({ state, activity, taskId }).verification.status, 'needs-review')
})

test('repeated productive goal turns reset the unchanged-turn count', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  for (let turn = 1; turn <= 3; turn += 1) {
    host.emit('gb', 'turn/start', { turn })
    host.emit('gb', 'tool/call', { callId: `productive-${turn}`, name: 'pwsh', arguments: JSON.stringify({ command: `command-${turn}` }) })
    host.emit('gb', 'tool/result', { callId: `productive-${turn}`, message: { ok: true, content: [{ type: 'text', text: `green-${turn}` }] } })
    host.emit('gb', 'turn/end', { turn, reason: { kind: 'completed' } })
    await settle(() => (goal(host).stages[0].tasks[0].evidence ?? []).length === turn)
  }
  const task = goal(host).stages[0].tasks[0]
  assert.equal(task.progress.state, 'moving')
  assert.equal(task.progress.unchangedTurns, 0)
})

test('restart reconciliation fails closed and marks a goal task recovery-needed for unrelated events', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const before = goal(host).stages[0].tasks[0]
  const taskId = `goal:${goal(host).id}:${goal(host).stages[0].id}:${before.id}`
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Unrelated report' }] } } },
    { seq: 3, type: 'tool/call', data: { turn: 1, callId: 'other', name: 'pwsh', arguments: JSON.stringify({ command: 'other command' }) } },
    { seq: 4, type: 'tool/result', data: { turn: 1, callId: 'other', message: { ok: true, content: [{ type: 'text', text: 'green' }] } } },
  ]
  assert.equal(host.rt.reconcileGoalEvidence('gb', events, {
    taskId, attemptId: before.attempt.id, exchangeId: 'expected-exchange',
  }), false)
  await settle(() => goal(host).stages[0].tasks[0].recovery?.length > 0)
  const after = goal(host).stages[0].tasks[0]
  assert.equal((after.evidence ?? []).length, 0)
  assert.equal(after.recovery[0].kind, 'needs-review')
  const state = saved(host)
  const activity = buildTeamActivity({ state, now: Date.now(), timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId })
  assert.equal(detail.recovery.state, 'needs-review')
  assert.equal(detail.partial, true)
  assert.ok(detail.blockers.some(item => item.kind === 'recovery' && /could not be matched/i.test(item.text)))
  const matching = [
    { seq: 1, type: 'turn/start', data: { turn: 2 } },
    {
      seq: 2, type: 'user/message',
      data: {
        turn: 2, content: [{ type: 'text', text: 'Recovered task request' }],
        source: { kind: 'ds-bot', role: 'request', taskId, attemptId: before.attempt.id, exchangeId: 'expected-exchange' },
      },
    },
    { seq: 3, type: 'tool/call', data: { turn: 2, callId: 'matched', name: 'pwsh', arguments: JSON.stringify({ command: 'matched command' }) } },
    { seq: 4, type: 'tool/result', data: { turn: 2, callId: 'matched', message: { ok: true, content: [{ type: 'text', text: 'green' }] } } },
  ]
  assert.equal(host.rt.reconcileGoalEvidence('gb', matching, {
    taskId, attemptId: before.attempt.id, exchangeId: 'expected-exchange',
  }), true)
  await settle(() => (goal(host).stages[0].tasks[0].evidence ?? []).length === 1)
  assert.equal(goal(host).stages[0].tasks[0].recovery.some(item => item.kind === 'needs-review'), false)
})

test('a named goal change is applied once and its first receipt is replayed', async (t) => {
  const host = await start(t)
  await startGoal(host, { request_id: 'start-1' })

  const first = await host.tool('group_goal', { action: 'pass', evidence: 'reviewed', request_id: 'pass-1' }, 'ga')
  assert.equal(goal(host).current, 1)
  const replay = await host.tool('group_goal', { action: 'pass', evidence: 'reviewed', request_id: 'pass-1' }, 'ga')
  assert.equal(replay, first)
  assert.equal(goal(host).current, 1)

  const conflict = await host.tool('group_goal', { action: 'pass', evidence: 'different', request_id: 'pass-1' }, 'ga')
  assert.match(conflict, /request_id "pass-1" was already used for a different goal change/)
  assert.equal(goal(host).current, 1)
})

test('rework sends the current stage back; revise keeps passed stages and a matching task', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  assert.equal(goal(host).stages[0].tasks[0].status, 'working')
  assert.equal(await host.tool('group_goal', { action: 'rework' }, 'ga'), 'reason is required for rework.')
  await host.tool('group_goal', { action: 'rework', reason: 'missing tests' }, 'ga')
  const back = goal(host)
  assert.equal(back.stages[0].tasks[0].status, 'pending')
  assert.deepEqual([back.stages[0].reworks, back.stages[0].feedback], [1, 'missing tests'])

  await host.tool('group_goal', { action: 'pass', evidence: 'ok' }, 'ga')
  await host.tool('group_goal', { action: 'task', bot: 'Tester', status: 'working' }, 'ga')
  assert.equal(await host.tool('group_goal', { action: 'revise', stages: [STAGES[1]] }, 'ga'), 'reason is required for revise.')
  await host.tool('group_goal', {
    action: 'revise',
    reason: 'scope changed',
    stages: [
      { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
      { title: 'Wrap', acceptance: 'wrapped', tasks: [{ bot: 'Writer', task: 'wrap up' }] },
    ],
  }, 'ga')
  const revised = goal(host)
  assert.deepEqual(revised.stages.map(stage => [stage.id, stage.status]), [['s1', 'passed'], ['s3', 'active'], ['s4', 'pending']])
  assert.equal(revised.current, 1)
  // The same member's same task in the replaced current stage kept its status.
  assert.equal(revised.stages[1].tasks[0].status, 'working')
  assert.equal(revised.stages[1].tasks[0].botId, 'c')
})

test('pause, resume and stop refuse the wrong state and follow it', async (t) => {
  const host = await start(t)
  await startGoal(host)
  assert.equal(await host.tool('group_goal', { action: 'resume' }, 'ga'), 'The goal of "Ops" is active; resume needs it to be paused.')
  await host.tool('group_goal', { action: 'pause' }, 'ga')
  assert.equal(goal(host).status, 'paused')
  assert.equal(await host.tool('group_goal', { action: 'pass', evidence: 'e' }, 'ga'),
    'The goal of "Ops" is paused. The user resumes it; until then, talk with the user and write their corrections in with revise.')
  await host.tool('group_goal', { action: 'resume' }, 'ga')
  assert.equal(goal(host).status, 'active')
  assert.equal(await host.tool('group_goal', { action: 'stop' }, 'ga'), 'reason is required for stop.')
  await host.tool('group_goal', { action: 'stop', reason: 'no longer needed' }, 'ga')
  const stopped = goal(host)
  assert.deepEqual([stopped.status, stopped.reason], ['stopped', 'no longer needed'])
  assert.equal(await host.tool('group_goal', { action: 'pause' }, 'ga'), 'The goal of "Ops" is stopped; pause needs it to be active.')
})

test('only the admin or a Main Bot changes a goal; any member can show it', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: null, named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  assert.equal(await host.tool('group_goal', { action: 'start', objective: 'o', acceptance: 'a', stages: STAGES }, 'gb'),
    'Only Chief, the admin of "Ops", or a Main Bot changes its goal. Tell the admin in the group.')
  assert.match(await host.tool('group_goal', { action: 'show' }, 'gb'), /"Ops" has no goal/)
  assert.match(await host.tool('group_goal', { action: 'start', group: 'Ops', title: 'Ship it', objective: 'o', acceptance: 'a', stages: STAGES }, 'a'), /Started\./)
  assert.match(await host.tool('group_goal', { action: 'show' }, 'gb'), /The group works toward: Ship it/)
  assert.equal(await host.tool('group_goal', { action: 'start', group: 'Lab', objective: 'o', acceptance: 'a', stages: STAGES }, 'a'),
    '"Lab" has no admin, and a goal needs one to run it. Set an admin with update_group first.')
  assert.equal(await host.tool('group_goal', { action: 'stop', group: 'Lab', reason: 'r' }, 'c'),
    'Only a Main Bot changes the goal of "Lab".')
})

test('events keep the newest 50 and pastGoals keep 5', async (t) => {
  const host = await start(t)
  await startGoal(host)
  for (let i = 0; i < 60; i++) {
    await host.tool('group_goal', { action: 'task', bot: 'Writer', status: i % 2 === 0 ? 'working' : 'pending' }, 'ga')
  }
  assert.equal(goal(host).events.length, 50)
  for (let i = 0; i < 7; i++) {
    const id = goal(host).id
    await host.tool('group_goal', { action: 'stop', reason: `r${i}` }, 'ga')
    assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'clear' })).ok, true)
    await startGoal(host, { title: `g${i}` })
  }
  const room = saved(host).rooms.r1
  assert.equal(room.pastGoals.length, 5)
  assert.equal(room.pastGoals.at(-1).status, 'stopped')
})

test('the admin and member prompts carry the goal block', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  const admin = text(host.begin('ga'))
  assert.match(admin, /<group_goal status="active">/)
  assert.match(admin, /\[current\] 1\. Draft — done when: draft reviewed/)
  assert.match(admin, /- Writer: write the draft \[not started\]/)
  assert.match(admin, /\[next\] 2\. Check: Tester/)
  assert.match(admin, /You run this goal\./)
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  const member = text(host.begin('gb'))
  assert.match(member, /<group_goal status="active" stage="1\/2">/)
  // The admin's @Writer call already moved the task to working before this prompt.
  assert.match(member, /Your task in it: write the draft \(working\)\./)
  host.finish('gb', 'draft written')
  await settle(() => result() !== undefined)

  const again = host.round('c2', host.say('@Tester hello'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  assert.match(text(host.begin('gc')), /You have no task in this stage\./)
  host.finish('gc', '[PASS]')
  await settle(() => again() !== undefined)
})

test('a goal draft opens as the user\'s line and calls only the admin', async (t) => {
  const host = await start(t)
  assert.equal((await host.call('goal-draft', { roomId: 'r1', text: 'Ship the thing' })).ok, true)
  const drafted = goal(host)
  assert.deepEqual([drafted.status, drafted.by, drafted.brief], ['drafting', 'user', 'Ship the thing'])
  const post = host.takePost()
  assert.deepEqual([post.source.role, post.source.goal], ['goal', 'draft'])
  const result = host.round('c1', post)
  await settle(() => host.agentOf('ga').calls.length === 1)
  const prompt = text(host.begin('ga'))
  assert.match(prompt, /the user wants to set a goal for this group/)
  assert.match(prompt, /<group_goal status="drafting">/)
  assert.match(prompt, /goal-grill/)
  host.finish('ga', 'Aligned, starting it.')
  await settle(() => result() !== undefined)
  assert.deepEqual(host.agentOf('gb').calls.filter(call => call.source?.role !== 'post'), [])
  assert.deepEqual(host.agentOf('gc').calls, [])
  const log = logLines(host)
  assert.deepEqual(log.filter(line => line.text === 'Ship the thing').map(line => line.who), ['User'])
  assert.ok(log.some(line => line.reason === 'goal' && line.event === 'draft'))
  assert.ok(result().replies.some(reply => reply.kind === 'user' && reply.text === 'Ship the thing'))
})

test('a group with no admin refuses a goal draft', async (t) => {
  const host = await start(t, {}, undefined, {
    r2: { id: 'r2', name: 'Lab', members: ['a', 'c'], mode: 'admin', admin: null, named: true, sessions: {}, log: [], seq: 0, seen: {} },
  })
  const result = await host.call('goal-draft', { roomId: 'r2', text: 'x' })
  assert.equal(result.error.message, 'This group has no admin. Set one in the group settings first.')
})

test('an idle round wakes the admin for a goal check; [PASS] waits for the user', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // A user-message round ends with nothing running: the goal check queues once.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined, 'one goal check was queued')
  assert.match(text(nudge), /^\[Goal check\]$/)
  // The check opens a round on the admin alone, with the goal-check line.
  const check = host.round('c2', nudge)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.match(prompt, /goal check/)
  assert.match(prompt, /Goal check from DS Bot/)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => check() !== undefined)
  assert.equal(goal(host).idle, true)
  assert.equal(host.agentOf('r1').calls.filter(call => call.source?.role === 'goal' && call.source.goal === 'nudge').length, 0)
})

test('two goal checks without progress mark the goal idle; a user message clears it', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  // The first check: the admin only runs its own tools — that is not progress, so
  // the next check still queues.
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.emit('ga', 'tool/call', { callId: 'k1', name: 'list_bots', arguments: '{}' })
  host.finish('ga', 'waiting on the user')
  await settle(() => one() !== undefined)
  assert.equal(goal(host).nudges, 2)
  // The second check: same, so the goal waits for the user instead.
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await settle(() => two() !== undefined)
  assert.equal(goal(host).idle, true)
  // A user message clears the idle wait and the count starts over.
  const third = host.round('c4', host.say('@Chief new ask'))
  await settle(() => host.agentOf('ga').calls.length === 4)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => third() !== undefined)
  assert.deepEqual([goal(host).idle, goal(host).nudges], [undefined, 1])
})

test('a paused goal and a room at work do not get a goal check', async (t) => {
  const host = await start(t)
  await startGoal(host)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'checking in' }, 'b'), /Nobody answers it/)
  const paused = host.round('c1', host.takePost())
  await settle(() => paused() !== undefined)
  assert.equal(host.takeGoal(), undefined)
  // A member still at work in the room holds the check too.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  const wake = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'back on it')
  await settle(() => wake() !== undefined)
  host.agentOf('r1').calls.length = 0
  host.emit('gb', 'turn/start', { turn: 9 })
  assert.match(await host.tool('post_to_group', { group: 'Ops', message: 'more news' }, 'c'), /Nobody answers it/)
  const busy = host.round('c3', host.takePost())
  await settle(() => busy() !== undefined)
  assert.equal(host.takeGoal(), undefined)
})

test('an explicit goal task identity binds evidence from the Bot own chat', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  const task = goal(host).stages[0].tasks[0]
  const taskId = `goal:${goal(host).id}:${goal(host).stages[0].id}:${task.id}`
  host.emit('b', 'turn/start', { turn: 1 })
  host.emit('b', 'user/message', {
    content: [{ type: 'text', text: 'Run the checks.' }],
    source: { kind: 'ds-bot', taskId, attemptId: task.attempt.id, exchangeId: 'explicit-task' },
  })
  host.emit('b', 'tool/call', { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) })
  host.emit('b', 'tool/result', { callId: 'c1', exitCode: 0, message: { ok: true, exitCode: 0, content: [{ type: 'text', text: 'green' }] } })
  await settle(() => (goal(host).stages[0].tasks[0].evidence ?? []).length === 1)
  const current = goal(host).stages[0].tasks[0]
  assert.equal(current.attempt.id, task.attempt.id)
  assert.equal(current.attempt.sessionId, 'b')
  assert.equal(current.evidence[0].attemptId, task.attempt.id)
  assert.equal(current.evidence[0].command.text, 'npm test')
})

test('the goal tracks tasks as the admin calls and members answer', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const writerTask = () => goal(host).stages[0].tasks.find(task => task.botId === 'b')
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  await settle(() => writerTask().status === 'working')
  assert.equal(writerTask().attempt.sessionId, 'gb')
  assert.equal(writerTask().checkpoint.attemptId, writerTask().attempt.id)
  host.begin('gb')
  await settle(() => writerTask().attempt.exchangeId !== undefined)
  assert.match(writerTask().attempt.exchangeId, /^[0-9a-f-]{36}$/)
  assert.equal(host.agentOf('gb').calls[0].source.taskId, `goal:${goal(host).id}:${goal(host).stages[0].id}:${writerTask().id}`)
  assert.equal(host.agentOf('gb').calls[0].source.attemptId, writerTask().attempt.id)
  host.finish('gb', 'draft written, see out.md')
  await settle(() => writerTask().status === 'reported')
  await settle(() => result() !== undefined)
})

test('a failed model call and a user stop put the task back with a note', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  const writerTask = () => goal(host).stages[0].tasks.find(task => task.botId === 'b')
  const result = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => result() !== undefined)
  // Its model call fails after the round moved on.
  host.emit('gb', 'turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', status: 429, message: 'Too many requests' } } })
  await settle(() => writerTask().status === 'pending' && writerTask().note === 'Could not finish: its model call failed')
})

test('the user stopping a member puts its task back with a note', async (t) => {
  const host = await start(t)
  await startGoal(host)
  await host.tool('group_goal', { action: 'task', bot: 'Writer', status: 'working' }, 'ga')
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })).value, true)
  await settle(() => {
    const task = goal(host).stages[0].tasks[0]
    return task.status === 'pending' && task.note === 'Stopped by the user'
  })
})

test('goal-control pauses, resumes, stops and clears a goal', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const stale = await host.call('goal-control', { roomId: 'r1', goalId: 'goal-nope', action: 'pause' })
  assert.deepEqual([stale.error.code, stale.error.message], ['bot/stale', 'The goal has changed. Look again.'])
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  assert.equal(goal(host).status, 'paused')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).error.message,
    'The goal of "Ops" is paused; pause needs it to be active.')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })).ok, true)
  assert.equal(goal(host).status, 'active')
  const resumed = host.takeGoal()
  assert.deepEqual([resumed.source.goal, text(resumed)], ['resume', '[Goal resumed]'])
  const wake = host.round('c1', resumed)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /The user resumed the goal\. Take the next step now\./)
  host.begin('ga')
  host.finish('ga', 'back on it')
  await settle(() => wake() !== undefined)

  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })).ok, true)
  assert.equal(goal(host).status, 'stopped')
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'clear' })).ok, true)
  const room = saved(host).rooms.r1
  assert.equal(room.goal, undefined)
  assert.equal(room.pastGoals.length, 1)
})

test('pause with stopWork and stop stop the room\'s work', async (t) => {
  const host = await start(t)
  await startGoal(host)
  host.emit('gb', 'turn/start', { turn: 1 })
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause', stopWork: true })).ok, true)
  assert.equal(host.agentOf('gb').cancelled.length, 1)
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  host.takeGoal()
  host.emit('gc', 'turn/start', { turn: 1 })
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })).ok, true)
  assert.equal(host.agentOf('gc').cancelled.length, 1)
})

test('the tool stop stops the other members\' work, not the caller\'s', async (t) => {
  const host = await start(t)
  await startGoal(host)
  host.emit('gb', 'turn/start', { turn: 1 })
  host.emit('gc', 'turn/start', { turn: 1 })
  await host.tool('group_goal', { action: 'stop', reason: 'done for now' }, 'ga')
  assert.equal(goal(host).status, 'stopped')
  assert.equal(host.agentOf('gb').cancelled.length, 1)
  assert.equal(host.agentOf('gc').cancelled.length, 1)
  assert.equal(host.agentOf('ga').cancelled.length, 0)
})

test('a stale goal check calls nobody; a stale draft is a plain user message', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined)
  // The user pauses before the check runs: it opens a round that calls nobody.
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })
  const stale = host.round('c2', nudge)
  await settle(() => stale() !== undefined)
  assert.equal(host.agentOf('ga').calls.length, 1)
  // The round calls nobody; the pause the user made shows above it, where it happened.
  assert.deepEqual(stale().replies, [])
  // A draft whose goal was stopped keeps its user line and routes as a user post.
  const id = goal(host).id
  await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'stop' })
  await host.call('goal-control', { roomId: 'r1', goalId: id, action: 'clear' })
  await host.call('goal-draft', { roomId: 'r1', text: 'Build the site' })
  const draft = host.takeGoal()
  assert.deepEqual(draft.source.goal, 'draft')
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'stop' })
  assert.equal(goal(host).status, 'stopped')
  const plain = host.round('c3', draft)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const prompt = text(host.agentOf('ga').calls[1])
  assert.doesNotMatch(prompt, /the user wants to set a goal for this group/)
  host.begin('ga')
  host.finish('ga', 'the goal is stopped')
  await settle(() => plain() !== undefined)
  assert.ok(logLines(host).some(line => line.who === 'User' && line.text === 'Build the site'))
})

test('stop-room-work sets the goal waiting and no check follows the notice', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer write the draft')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => first() !== undefined)
  assert.equal((await host.call('stop-room-work', { roomId: 'r1' })).value, true)
  await settle(() => goal(host).idle === true)
  await settle(() => host.agentOf('r1').calls.length > 0)
  // The stop notices open a quiet round that calls nobody and queues no check.
  const notices = []
  while (host.agentOf('r1').calls.length > 0) notices.push(host.takePost())
  for (const notice of notices) {
    const quiet = host.round(`s${notices.indexOf(notice)}`, notice)
    await settle(() => quiet() !== undefined)
  }
  assert.equal(host.agentOf('ga').calls.length, 1)
  assert.equal(host.takeGoal(), undefined)
})

for (const [endpoint, body] of [['stop-room-work', { roomId: 'r1' }], ['stop-member-work', { roomId: 'r1', botId: 'b' }]]) {
  test(`${endpoint} that fails still sets the goal waiting`, async (t) => {
    const host = await start(t)
    await startGoal(host)
    host.emit('gb', 'turn/start', { turn: 1 })
    host.agentOf('gb').cancel = () => { throw new Error('cancel failed') }
    assert.equal((await host.call(endpoint, body)).ok, false)
    const { rooms } = (await host.call('state', {})).value
    assert.equal(rooms.find(room => room.id === 'r1').goal.idle, true)
  })
}

test('a batch member that finishes first is reported while its peer still works', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const host = await start(t)
  await startGoal(host, {
    stages: [
      { title: 'Draft', acceptance: 'draft reviewed', tasks: [{ bot: 'Writer', task: 'write the draft' }, { bot: 'Tester', task: 'check the draft' }] },
      { title: 'Check', acceptance: 'checks pass', tasks: [{ bot: 'Tester', task: 'run the checks' }] },
    ],
  })
  const taskOf = botId => goal(host).stages[0].tasks.find(task => task.botId === botId)
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer @Tester start the draft')
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.emit('gb', 'tool/call', { callId: 'k1', name: 'pwsh', arguments: '{}' })
  host.begin('gc')
  host.emit('gc', 'tool/call', { callId: 'k2', name: 'pwsh', arguments: '{}' })
  t.mock.timers.tick(ROOM_WORK_GRACE_MS * 2)
  await settle(() => first() !== undefined)
  await settle(() => taskOf('b').status === 'working' && taskOf('c').status === 'working')
  // Writer posts its result while Tester is still at work: reported at once.
  host.finish('gb', 'draft written, see out.md')
  await settle(() => taskOf('b').status === 'reported')
  assert.equal(taskOf('c').status, 'working')
})

test('a member call while the goal waits brings it back', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // Drive the goal to idle: a user round, then two checks the admin passes on.
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '[PASS]')
  await settle(() => first() !== undefined)
  const one = host.round('c2', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', 'waiting')
  await settle(() => one() !== undefined)
  const two = host.round('c3', host.takeGoal())
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', 'still waiting')
  await settle(() => two() !== undefined)
  assert.equal(goal(host).idle, true)
  // The admin's own post calling a member clears the wait through the task hook.
  await host.tool('post_to_group', { group: 'Ops', message: '@Writer write the draft' }, 'a')
  const third = host.round('c4', host.takePost())
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')
  host.finish('gb', 'on it')
  await settle(() => third() !== undefined)
  assert.equal(goal(host).idle, undefined)
})

test('a refused revise changes nothing; the stage cap counts kept stages', async (t) => {
  const host = await start(t)
  await startGoal(host)
  const before = goal(host)
  const refused = await host.tool('group_goal', {
    action: 'revise',
    title: 'New title',
    reason: 'r',
    stages: [{ title: 'S', acceptance: 'x', tasks: [{ bot: 'Nobody', task: 't' }] }],
  }, 'ga')
  assert.equal(refused, 'Nobody is not a member of "Ops". Members: Chief, Writer, Tester.')
  assert.deepEqual(goal(host), before)
  // A goal near the cap keeps its passed stages: revising past 20 is refused whole.
  const many = count => Array.from({ length: count }, (_, i) => ({ title: `S${i + 1}`, acceptance: 'x', tasks: [{ bot: 'Writer', task: `t${i}` }] }))
  await host.tool('group_goal', { action: 'revise', reason: 'grow', stages: many(19) }, 'ga')
  for (let i = 0; i < 19; i++) await host.tool('group_goal', { action: 'pass', evidence: 'e' }, 'ga')
  assert.equal(goal(host).current, 19)
  const over = await host.tool('group_goal', { action: 'revise', reason: 'more', stages: many(3) }, 'ga')
  assert.equal(over, 'At most 20 stages.')
  assert.equal(goal(host).stages.length, 19)
})

test('a draft queued with another post still calls the admin on its note', async (t) => {
  const host = await start(t)
  await host.call('goal-draft', { roomId: 'r1', text: 'Build the site' })
  const draft = host.takeGoal()
  // The draft lands first; the user's own message, queued second, opens the round.
  host.emit('r1', 'user/message', { content: draft.content, source: draft.source })
  const result = host.round('c1', host.say('@Tester look at this'))
  await settle(() => host.agentOf('gc').calls.length === 1)
  await settle(() => host.agentOf('ga').calls.length === 1)
  assert.match(text(host.agentOf('ga').calls[0]), /the user wants to set a goal for this group/)
  host.begin('ga')
  host.finish('ga', 'Aligning it.')
  host.begin('gc')
  host.finish('gc', '[PASS]')
  await settle(() => result() !== undefined)
  assert.ok(logLines(host).some(line => line.who === 'User' && line.text === 'Build the site'))
})

test('a room on its second part relays on the current Session and blocks /goal there', async (t) => {
  // The group's own Session moved on: r1 is an earlier part, r1p2 the current one.
  const blocked = []
  const goals = {
    get: agent => agent.session?.id === 'r1p2' ? { id: 'g-dsh', revision: 3, phase: 'active' } : undefined,
    block(agent, ref, reason) { blocked.push({ sessionId: agent.session?.id ?? agent.id, ref, reason }) },
  }
  const host = await start(t, { sessionId: 'r1p2', parts: [{ sessionId: 'r1', endedAt: 1 }] }, { goals })
  await startGoal(host)
  assert.equal((await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'pause' })).ok, true)
  await host.call('goal-control', { roomId: 'r1', goalId: goal(host).id, action: 'resume' })
  // The resume relay goes to the current part, never to the earlier one.
  await settle(() => host.agentOf('r1p2').calls.some(call => call.source?.role === 'goal'))
  assert.equal(host.agentOf('r1').calls.length, 0)
  // A DSH /goal in the current part reads as the room's and is blocked.
  host.emit('r1p2', 'goal/change', { goal: { phase: 'active' } })
  await settle(() => blocked.length === 1)
  assert.equal(blocked[0].sessionId, 'r1p2')
  assert.equal(blocked[0].reason.message, 'Bot chats do not run /goal. To give a group a goal, use Set a goal in its + menu.')
})

test('a member still working at round end wakes the admin when its work settles', async (t) => {
  const host = await start(t)
  await startGoal(host)
  // Member c's group turn is still running when the round ends — no check is queued.
  host.emit('gc', 'turn/start', { turn: 1 })
  const first = host.round('c1', host.say('@Chief go'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', 'on it')
  await settle(() => first() !== undefined)
  assert.equal(host.takeGoal(), undefined)
  // The round is fully gone before c's work ends; the settle check then queues one goal check.
  await settle(async () => (await host.call('room-progress', { roomId: 'r1' })).value?.length === 0)
  host.emit('gc', 'assistant/message', { message: { content: [{ type: 'text', text: 'done' }] } })
  host.emit('gc', 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle(() => host.agentOf('r1').calls.some(call => call.source?.role === 'goal'))
  const nudge = host.takeGoal()
  assert.ok(nudge !== undefined)
  assert.match(text(nudge), /^\[Goal check\]$/)
  // A second settle with no new work queues nothing while a round is running.
  host.emit('gc', 'turn/start', { turn: 2 })
  host.emit('gc', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  await settle(async () => (await host.call('room-progress', { roomId: 'r1' })).value?.length === 0)
  const left = host.agentOf('r1').calls.filter(call => call.source?.role === 'goal')
  assert.ok(left.length <= 1, `settles queued ${left.length} extra checks`)
  assert.equal(host.takeGoal(), undefined)
})
