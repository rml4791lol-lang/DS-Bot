import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createRuntime } from '../../../index.js'

const args = JSON.parse(process.argv[2])
process.env.DSH_HOME = args.dshHome
const route = { provider: 'reality-gate-local', model: 'deterministic-agentloop-model' }
const sha = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const messageText = message => (message?.content ?? []).map(block => block.text ?? '').join('\n')
const taskMarkers = ['START_REALITY_GATE', 'FORGE_TASK', 'PRISM_REVIEW', '[Reply from Forge]', '[Reply from Prism]']
const latestUser = messages => {
  let index = messages.findLastIndex(message => message.role === 'user'
    && taskMarkers.some(marker => messageText(message).includes(marker)))
  if (index === -1) index = messages.findLastIndex(message => message.role === 'user'
    && !messageText(message).startsWith('Current runtime context.')
    && !messageText(message).startsWith('Current time:'))
  return index === -1 ? { index: -1, text: '' } : { index, text: messageText(messages[index]) }
}
const assistantSteps = messages => {
  const user = latestUser(messages)
  return messages.slice(user.index + 1).filter(message => message.role === 'assistant').length
}
const toolResults = messages => messages
  .filter(message => message.role === 'tool')
  .map(message => messageText(message))
  .filter(Boolean)

function chunkToolCall(index, call) {
  const raw = JSON.stringify(call.arguments)
  return [
    { type: 'block-start', index, blockType: 'tool-call' },
    { type: 'tool-call-delta', index, id: call.id, name: call.name, argumentsDelta: raw },
    { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: raw } },
  ]
}

function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(calls) {
  return [...calls.flatMap((call, index) => chunkToolCall(index, call)), { type: 'finish', reason: { kind: 'tool-calls' } }]
}

class DeterministicAgentLoopAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
    this.calls = []
  }

  providerInfo(provider) {
    return { id: provider, name: 'Reality Gate deterministic local adapter' }
  }

  async listModels(provider) {
    return [{ provider, id: route.model, name: 'Deterministic AgentLoop model' }]
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } }
  }

  async *stream(options) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted')
    this.calls.push({ sessionId: String(options.sessionId), messages: options.messages })
    const sessionId = String(options.sessionId)
    const latest = latestUser(options.messages).text
    const step = assistantSteps(options.messages)
    const turnId = `${sessionId}-${this.calls.length}`
    const checks = this.config.checks

    if (latest.startsWith('The Bot:') && latest.includes('Write every new or changed entry')) {
      yield* textResponse('{"changes":[]}')
      return
    }

    if (sessionId === 'chief' && latest.includes('START_REALITY_GATE') && step === 0) {
      yield* toolResponse([
        {
          id: `${turnId}-goal`,
          name: 'group_goal',
          arguments: {
            action: 'start',
            group: 'Reality Gate',
            title: 'Repair MCP inventory drift',
            objective: 'Repair the real MCP inventory filter and independently verify the actual diff, tests, inventory behavior and no-DSH-patch invariant.',
            acceptance: 'Forge returns a durable repair and Prism verifies it with real AgentLoop tool calls after a host restart.',
            checks: [{ id: 'overall-no-patch', kind: 'command', label: 'DSH stayed unpatched', command: checks.noPatch, expect: { exitCode: 0 } }],
            constraints: ['Use the isolated worktree only.', 'Do not modify DSH, user DSH data, workflows, or secrets.', 'Do not commit, push, deploy or send externally.'],
            stages: [
              {
                title: 'Repair',
                acceptance: 'The actual MCP repair diff exists and its inventory check passes.',
                checks: [checks.repairDiff, checks.repairCommand],
                tasks: [{ bot: 'Forge', task: 'FORGE_TASK Repair MCP inventory drift in the isolated worktree, run the pre-repair failure and post-repair inventory check, write forge-handoff.json, then report the durable result.' }],
              },
              {
                title: 'Review',
                acceptance: 'Prism independently runs the diff, inventory, targeted tests and no-DSH-patch checks after the restart.',
                checks: checks.reviewChecks,
                tasks: [{ bot: 'Prism', task: 'PRISM_REVIEW Independently inspect the actual diff, run MCP inventory behavior and targeted tests, and prove DSH was not patched.' }],
              },
            ],
          },
        },
        { id: `${turnId}-forge-working`, name: 'group_goal', arguments: { action: 'task', group: 'Reality Gate', bot: 'Forge', status: 'working', note: 'Repair assigned by Chief.' } },
        { id: `${turnId}-forge`, name: 'message_bot', arguments: { to: 'Forge', message: 'FORGE_TASK Begin the assigned repair. Use the worktree tools and report the durable result to Chief.', when: 'now' } },
      ])
      return
    }

    if (sessionId === 'forge' && latest.includes('FORGE_TASK')) {
      if (step === 0) {
        yield* toolResponse([
          { id: `${turnId}-before`, name: 'bash', arguments: { command: checks.repairCommand.command } },
        ])
        return
      }
      if (step === 1) {
        yield* toolResponse([
          { id: `${turnId}-edit`, name: 'edit', arguments: checks.edit },
        ])
        return
      }
      if (step === 2) {
        const handoff = {
          schema: 1,
          owner: { name: 'Forge', role: 'Engineer' },
          changedPaths: [checks.repairDiff.path],
          commands: [
            { command: checks.repairCommand.command, expectedExitCode: 1, result: 'The inventory fixture failed before the repair.' },
            { command: checks.repairCommand.command, expectedExitCode: 0, result: 'The inventory fixture passed after the repair.' },
          ],
          limitations: 'Deterministic local model transport; the AgentLoop, Session events, tool dispatch and persistence are real DSH.',
          generatedBy: 'real DSH AgentLoop tool calls',
        }
        yield* toolResponse([
          { id: `${turnId}-after`, name: 'bash', arguments: { command: checks.repairCommand.command } },
          { id: `${turnId}-handoff`, name: 'write_file', arguments: { path: 'forge-handoff.json', content: `${JSON.stringify(handoff, null, 2)}\n` } },
        ])
        return
      }
      const results = toolResults(options.messages)
      yield* textResponse(`Forge repaired ${checks.repairDiff.path}. Durable handoff: forge-handoff.json. Tool evidence: ${results.slice(-2).join(' | ').slice(0, 1200)}`)
      return
    }

    if (sessionId === 'chief' && latest.includes('[Reply from Forge]') && step === 0) {
      yield* toolResponse([
        { id: `${turnId}-reported`, name: 'group_goal', arguments: { action: 'task', group: 'Reality Gate', bot: 'Forge', status: 'reported', note: 'Durable repair result received.' } },
        { id: `${turnId}-pass`, name: 'group_goal', arguments: { action: 'pass', group: 'Reality Gate', evidence: 'Forge repair diff and post-repair MCP inventory command are recorded in the task attempt.' } },
        { id: `${turnId}-prism-working`, name: 'group_goal', arguments: { action: 'task', group: 'Reality Gate', bot: 'Prism', status: 'working', note: 'Review assigned; delivery survives the restart boundary.' } },
        { id: `${turnId}-prism`, name: 'message_bot', arguments: { to: 'Prism', message: 'PRISM_REVIEW Review the durable Forge repair. Run the actual diff, MCP inventory, targeted tests and no-DSH-patch checks through your tools.', when: 'now' } },
      ])
      return
    }

    if (sessionId === 'prism' && latest.includes('PRISM_REVIEW')) {
      if (step === 0) {
        yield* toolResponse([
          { id: `${turnId}-diff`, name: 'git_diff', arguments: { path: checks.repairDiff.path } },
          { id: `${turnId}-diff-check`, name: 'bash', arguments: { command: checks.diffCheck } },
          { id: `${turnId}-targeted`, name: 'bash', arguments: { command: checks.targetedTest } },
          { id: `${turnId}-inventory`, name: 'bash', arguments: { command: checks.inventory } },
          { id: `${turnId}-no-patch`, name: 'bash', arguments: { command: checks.noPatch } },
        ])
        return
      }
      if (step === 1) {
        const review = {
          reviewer: 'Prism',
          verdict: 'pass',
          actualDiff: checks.repairDiff.path,
          checks: [checks.diffCheck, checks.targetedTest, checks.inventory, checks.noPatch],
          results: toolResults(options.messages).map(resultText => ({ digest: sha(resultText), output: resultText.slice(0, 1000) })),
          limitations: 'Deterministic local model transport; DSH AgentLoop, Session events, tool calls, restart recovery and persistence are real.',
        }
        yield* toolResponse([
          { id: `${turnId}-review`, name: 'write_file', arguments: { path: 'prism-review.json', content: `${JSON.stringify(review, null, 2)}\n` } },
        ])
        return
      }
      yield* textResponse(`Prism review passed. The actual diff, MCP inventory, targeted tests and no-DSH-patch checks all ran through real DSH tool calls. Review: prism-review.json`)
      return
    }

    if (sessionId === 'chief' && latest.includes('[Reply from Prism]') && step === 0) {
      yield* toolResponse([
        { id: `${turnId}-prism-reported`, name: 'group_goal', arguments: { action: 'task', group: 'Reality Gate', bot: 'Prism', status: 'reported', note: 'Independent review evidence received.' } },
        { id: `${turnId}-pass`, name: 'group_goal', arguments: { action: 'pass', group: 'Reality Gate', evidence: 'Prism ran the actual diff, inventory, targeted tests and no-DSH-patch checks after restart.' } },
        { id: `${turnId}-complete`, name: 'group_goal', arguments: { action: 'complete', group: 'Reality Gate', evidence: 'Typed stage checks are verified by Prism tool results after the child-process restart.', summary: 'Forge repaired MCP inventory drift and Prism independently verified it; the durable task, attempt, evidence and single post-restart pickup survived.' } },
      ])
      return
    }

    yield* textResponse(' ')
  }
}

function withinWorktree(path) {
  const absolute = resolve(args.worktree, path)
  const rel = relative(args.worktree, absolute)
  if (rel.startsWith('..') || rel === '' || resolve(args.worktree, rel) !== absolute) throw new Error(`path is outside the isolated worktree: ${path}`)
  return absolute
}

function commandTool() {
  return defineTool({
    name: 'bash',
    description: 'Run a shell command in the isolated acceptance worktree.',
    parameters: { command: { type: 'string', required: true, description: 'Command to run' } },
    output: {
      schema: {
        type: 'object',
        properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `exit ${value.exitCode}\n${value.stdout}${value.stderr}` }],
      presentationMeta: (_args, value) => ({ exitCode: value.exitCode }),
    },
    async execute(toolArgs, exec) {
      return await new Promise((resolveResult, reject) => {
        const child = spawn('/bin/zsh', ['-lc', toolArgs.command], {
          cwd: join(args.worktree, 'ds-bot'),
          env: {
            PATH: process.env.PATH,
            HOME: args.dshHome,
            TMPDIR: process.env.TMPDIR,
            LANG: process.env.LANG ?? 'en_US.UTF-8',
            NO_COLOR: '1',
            DSH_PATCH_BASELINE: args.patchBaseline,
            DSH_PATCH_TARGETS: JSON.stringify(args.patchTargets),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')
        child.stdout.on('data', chunk => { stdout += chunk })
        child.stderr.on('data', chunk => { stderr += chunk })
        const abort = () => child.kill('SIGTERM')
        exec.signal?.addEventListener('abort', abort, { once: true })
        child.on('error', reject)
        child.on('close', (code) => {
          exec.signal?.removeEventListener('abort', abort)
          resolveResult({ exitCode: code ?? 1, stdout, stderr })
        })
      })
    },
  })
}

function editTool() {
  return defineTool({
    name: 'edit',
    description: 'Replace one exact block in a worktree file and report the real diff.',
    parameters: { path: { type: 'string', required: true }, oldText: { type: 'string', required: true }, newText: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `edited ${value.path}` }],
      presentationMeta: (_args, value) => ({ diffs: [value] }),
    },
    async execute(toolArgs) {
      const path = withinWorktree(toolArgs.path)
      const before = readFileSync(path, 'utf8')
      if (!before.includes(toolArgs.oldText)) throw new Error(`fixture marker not found in ${toolArgs.path}`)
      const after = before.replace(toolArgs.oldText, toolArgs.newText)
      writeFileSync(path, after, 'utf8')
      return { path: toolArgs.path, oldText: before, newText: after }
    },
  })
}

function writeFileTool() {
  return defineTool({
    name: 'write_file',
    description: 'Write one artifact in the isolated worktree.',
    parameters: { path: { type: 'string', required: true }, content: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, digest: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `wrote ${value.path}` }],
      presentationMeta: (_args, value) => ({ artifact: value }),
    },
    async execute(toolArgs) {
      const path = withinWorktree(toolArgs.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, toolArgs.content, 'utf8')
      return { path: toolArgs.path, digest: sha(toolArgs.content) }
    },
  })
}

function gitDiffTool() {
  return defineTool({
    name: 'git_diff',
    description: 'Read the actual Git diff for one file and report its paths and text.',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: {
        type: 'object',
        properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: `actual diff ${value.path}: ${value.oldText.length} bytes -> ${value.newText.length} bytes` }],
      presentationMeta: (_args, value) => ({ diffs: [value] }),
    },
    async execute(toolArgs) {
      const path = withinWorktree(toolArgs.path)
      const oldText = execFileSync('git', ['show', `HEAD:${toolArgs.path}`], { cwd: args.worktree, encoding: 'utf8' })
      const newText = readFileSync(path, 'utf8')
      return { path: toolArgs.path, oldText, newText }
    },
  })
}

function eventSummary(sessionId, events) {
  const calls = new Map()
  const toolCalls = []
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data)
    if (event.type !== 'tool/result') continue
    const callId = event.data.callId ?? event.data.message?.toolCallId
    const call = calls.get(callId)
    const meta = event.data.meta ?? event.data.message?.meta
    const content = (event.data.message?.content ?? []).map(block => block.text ?? '').join('\n')
    toolCalls.push({
      name: call?.name,
      arguments: call?.arguments,
      callId,
      ok: event.data.message?.ok ?? event.data.message?.isError === false,
      exitCode: event.data.exitCode ?? event.data.message?.exitCode ?? meta?.exitCode,
      output: content.slice(0, 12_000),
      meta,
    })
  }
  const types = {}
  for (const event of events) types[event.type] = (types[event.type] ?? 0) + 1
  return {
    sessionId,
    eventCount: events.length,
    eventTypes: types,
    turnsStarted: events.filter(event => event.type === 'turn/start').length,
    turnsEnded: events.filter(event => event.type === 'turn/end' && event.data.reason?.kind === 'completed').length,
    turnEnds: events.filter(event => event.type === 'turn/end').map(event => event.data),
    toolCalls,
    assistantTexts: events
      .filter(event => event.type === 'assistant/message')
      .map(event => messageText(event.data.message))
      .filter(text => text.trim() !== ''),
  }
}

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
await ctx.plugin(SessionPersistenceJsonl, { root: args.sessionRoot, compression: 'none' })
const adapter = new DeterministicAgentLoopAdapter(args)
ctx.llm.registerAdapter([route.provider], adapter)

const registeredRoutes = []
ctx.provide('connection', { fetch: { register(routeDefinition) { registeredRoutes.push(routeDefinition.path); return () => {} } } })
ctx.provide('workspaceRegistry', {
  get: () => undefined,
  resolveByPath: async path => ({ id: 'reality-gate', path }),
  resolve: async id => ({ id, path: args.worktree }),
  create: async path => ({ id: 'reality-gate', path }),
  archiveSession: async () => {},
})
ctx.provide('sessionTitle', { rename: async () => {} })
const harness = await mountAgentLoopTestHarness(ctx)
const agents = new Map()
const handles = []
const pendingAgents = new Map()

async function readStored(sessionId) {
  const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function ensureAgent(sessionId) {
  if (agents.has(sessionId)) return agents.get(sessionId)
  if (pendingAgents.has(sessionId)) return await pendingAgents.get(sessionId)
  const pending = (async () => {
    let stored
    try {
      stored = await ctx.sessionPersistence.stat(SessionId(sessionId))
    } catch {}
    let agent
    if (stored === undefined) {
      agent = await harness.create(SessionId(sessionId), route, { cwd: args.worktree })
    } else {
      const handle = await ctx.agentLoop.resume(ctx, { resumeSessionId: SessionId(sessionId), agentOptions: route })
      handles.push(handle)
      agent = handle.agent
    }
    if (args.stage === 'first' && sessionId === 'prism') {
      // The real Prism Agent and Session are persisted, but its first turn is
      // withheld until the next host process. DS Bot's delivery wrapper records
      // the refused wake in inflight.json before this reaches the tool call.
      const defer = () => { throw Object.assign(new Error('Prism starts only after the host restart'), { code: 'PRISM_DEFERRED' }) }
      Object.defineProperties(agent, {
        followup: { configurable: true, value: defer },
        steer: { configurable: true, value: defer },
      })
    }
    agents.set(sessionId, agent)
    return agent
  })()
  pendingAgents.set(sessionId, pending)
  try {
    return await pending
  } finally {
    pendingAgents.delete(sessionId)
  }
}

ctx.provide('sessionController', {
  async resolveAgent(sessionId) {
    try {
      return { agent: await ensureAgent(String(sessionId)) }
    } catch (error) {
      return { error: { code: error.code ?? 'SESSION_UNAVAILABLE', message: error.message } }
    }
  },
  async create() { throw new Error('sessionController.create is outside the Reality Gate scenario') },
  async selectModel() {},
  async inspect(sessionId) {
    try {
      return { events: await readStored(String(sessionId)) }
    } catch {
      return undefined
    }
  },
  list: async () => ({ items: [] }),
  async page({ address, throughSeq, beforeSeq, maxMessages = 50 }) {
    const sessionId = String(address.sessionId)
    const events = agents.has(sessionId)
      ? agents.get(sessionId).session.snapshotEvents()
      : await readStored(sessionId)
    const eligible = events.filter(event => event.seq <= throughSeq && (beforeSeq === undefined || event.seq < beforeSeq))
    const start = Math.max(0, eligible.length - maxMessages)
    return {
      records: eligible.slice(start).map(event => ({ event })),
      hasMore: start > 0,
    }
  },
  projections: async () => ({}),
  prompt: async () => ({}),
})

ctx.tools.register(commandTool())
ctx.tools.register(editTool())
ctx.tools.register(writeFileTool())
ctx.tools.register(gitDiffTool())

const rt = createRuntime(ctx, { home: join(args.dshHome, 'bot') })
await rt.load()

async function flushAll() {
  for (const agent of agents.values()) await ctx.sessions.flush(agent.session)
  await ctx.sessionPersistence.flush()
  await rt.save()
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function waitForIdle(agent) {
  return await new Promise((resolveIdle, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('timed out waiting for AgentLoop idle')) }, 60_000)
    const off = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      off()
      resolveIdle()
    })
  })
}

const markerPath = args.marker
if (args.stage === 'first') {
  const chief = await ensureAgent('chief')
  const idle = waitForIdle(chief)
  chief.followup(createUserMessage({ content: [{ type: 'text', text: 'START_REALITY_GATE' }], source: { kind: 'user' } }))
  await idle
  try {
    await waitFor(
      () => {
        const goal = rt.state.rooms?.['r1']?.goal
        const prism = goal?.stages?.[1]?.tasks?.[0]
        let notes
        try { notes = JSON.parse(readFileSync(join(args.dshHome, 'bot', 'inflight.json'), 'utf8')) } catch {}
        return goal?.stages?.[0]?.status === 'passed'
          && prism?.attempt?.id !== undefined
          && notes?.queued?.prism?.some(item => item.args?.toId === 'prism' && item.args?.attemptId === prism.attempt.id)
      },
      20_000,
      'Forge evidence and queued Prism handoff',
    )
  } catch (error) {
    writeFileSync(markerPath, JSON.stringify({
      stage: 'first-timeout',
      error: error.message,
      unreadPrism: rt.unreadOf?.('prism'),
      inflight: (() => { try { return JSON.parse(readFileSync(join(args.dshHome, 'bot', 'inflight.json'), 'utf8')) } catch { return undefined } })(),
      works: rt.state.works,
      prismEvents: (agents.get('prism')?.session.snapshotEvents() ?? []).map(event => event.type),
    }, null, 2))
    throw error
  }
  await flushAll()
  const goal = rt.state.rooms.r1.goal
  const forgeTask = goal.stages[0].tasks[0]
  const prismTask = goal.stages[1].tasks[0]
  const notes = JSON.parse(readFileSync(join(args.dshHome, 'bot', 'inflight.json'), 'utf8'))
  writeFileSync(markerPath, JSON.stringify({
    stage: 'first-ready',
    pid: process.pid,
    goalId: goal.id,
    forge: { taskId: `goal:${goal.id}:s1:${forgeTask.id}`, attemptId: forgeTask.attempt.id, evidence: forgeTask.evidence ?? [] },
    prism: { taskId: `goal:${goal.id}:s2:${prismTask.id}`, attemptId: prismTask.attempt.id },
    queuedPrismHandoffs: notes.queued.prism?.filter(item => item.args.toId === 'prism').length ?? 0,
    prismSessionExistedBeforeRestart: await ctx.sessionPersistence.stat(SessionId('prism')).then(() => true, () => false),
    prismTurnStartsBeforeRestart: (await readStored('prism')).filter(event => event.type === 'turn/start').length,
    adapterCalls: adapter.calls.length,
    registeredRoutes,
  }, null, 2))
  setInterval(() => {}, 1 << 30)
} else {
  writeFileSync(markerPath, JSON.stringify({ stage: 'second-started', pid: process.pid, distinctChildProcess: true }, null, 2))
  try {
    await waitFor(() => rt.state.rooms?.['r1']?.goal?.status === 'complete', 15_000, 'Chief completion after Prism review')
  } catch (error) {
    const timeoutGoal = rt.state.rooms?.r1?.goal
    const timeoutTask = timeoutGoal?.stages?.[1]?.tasks?.[0]
    const timeoutCalls = eventSummary('prism', agents.get('prism')?.session.snapshotEvents() ?? []).toolCalls
    writeFileSync(markerPath, JSON.stringify({
      stage: 'second-timeout',
      error: error.message,
      goal: timeoutGoal === undefined ? undefined : { id: timeoutGoal.id, status: timeoutGoal.status, current: timeoutGoal.current, stage2: { status: timeoutGoal.stages[1]?.status, task: { status: timeoutTask?.status, attempt: timeoutTask?.attempt, verification: timeoutTask?.verification, evidence: (timeoutTask?.evidence ?? []).map(item => ({ id: item.id, command: item.command, diff: item.diff, attemptId: item.attemptId })) } } },
      prismToolCalls: timeoutCalls.map(call => ({ name: call.name, arguments: call.arguments, ok: call.ok, exitCode: call.exitCode, output: call.output?.slice(0, 1600), meta: call.name === 'git_diff' ? undefined : call.meta })),
      prismTurnEnds: (agents.get('prism')?.session.snapshotEvents() ?? []).filter(event => event.type === 'turn/end').map(event => event.data),
      adapterCalls: adapter.calls.length,
    }, null, 2))
    throw error
  }
  await flushAll()
  const goal = rt.state.rooms.r1.goal
  const prismTask = goal.stages[1].tasks[0]
  const prism = agents.get('prism')
  const chief = agents.get('chief')
  const prismEvents = prism.session.snapshotEvents()
  const chiefEvents = chief.session.snapshotEvents()
  const forgeEvents = await readStored('forge')
  const prismPickups = prismEvents.filter(event => event.type === 'user/message'
    && event.data?.source?.taskId === `goal:${goal.id}:s2:${prismTask.id}`
    && event.data?.source?.attemptId === prismTask.attempt.id)
  const review = JSON.parse(readFileSync(join(args.worktree, 'prism-review.json'), 'utf8'))
  const result = {
    stage: 'second-complete',
    pid: process.pid,
    distinctChildProcess: true,
    goal: {
      id: goal.id,
      status: goal.status,
      verification: goal.verification,
      summary: goal.summary,
      stages: goal.stages.map(stage => ({
        id: stage.id,
        title: stage.title,
        status: stage.status,
        checks: stage.checks,
        tasks: stage.tasks.map(task => ({
          id: task.id,
          botId: task.botId,
          status: task.status,
          attempt: task.attempt,
          checkpoint: task.checkpoint,
          verification: task.verification,
          evidence: task.evidence,
          recovery: task.recovery,
        })),
      })),
    },
    prism: {
      taskId: `goal:${goal.id}:s2:${prismTask.id}`,
      attemptId: prismTask.attempt.id,
      pickupCount: prismPickups.length,
      recovery: prismTask.recovery ?? [],
      summary: eventSummary('prism', prismEvents),
      review,
    },
    forge: {
      taskId: `goal:${goal.id}:s1:${goal.stages[0].tasks[0].id}`,
      attemptId: goal.stages[0].tasks[0].attempt.id,
      evidence: goal.stages[0].tasks[0].evidence,
      summary: eventSummary('forge', forgeEvents),
    },
    chief: { summary: eventSummary('chief', chiefEvents) },
    agentLoop: {
      adapterCalls: adapter.calls.length,
      sessions: Object.fromEntries([...agents].map(([id, agent]) => [id, eventSummary(id, agent.session.snapshotEvents())])),
    },
    sessionPersistence: {
      prismEventCount: prismEvents.length,
      forgeEventCount: forgeEvents.length,
      chiefEventCount: chiefEvents.length,
    },
  }
  writeFileSync(markerPath, JSON.stringify(result, null, 2))
  setInterval(() => {}, 1 << 30)
}
