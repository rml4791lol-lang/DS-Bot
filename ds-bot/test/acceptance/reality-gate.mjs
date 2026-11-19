import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { diffDigest } from '../../src/host/task-evidence.js'
import { buildTaskDetail } from '../../src/host/task-detail.js'
import { buildTeamActivity } from '../../src/host/team-activity.js'
import { snapshotTargets } from './fixtures/dsh-invariant.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = dirname(dirname(HERE))
const REPO = dirname(PLUGIN)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const outputOf = run => [run.stdout, run.stderr].filter(Boolean).join('\n').trim()

function command(cwd, line) {
  const env = { ...process.env, NO_COLOR: '1' }
  delete env.NODE_TEST_CONTEXT
  const result = spawnSync('/bin/zsh', ['-lc', line], {
    cwd,
    encoding: 'utf8',
    env,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    command: line,
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ok: result.status === 0,
  }
}

function checked(cwd, line) {
  const result = command(cwd, line)
  if (!result.ok) throw new Error(`${line}\n${outputOf(result)}`)
  return result
}

function replaceOnce(path, from, to) {
  const source = readFileSync(path, 'utf8')
  if (!source.includes(from)) throw new Error(`fixture marker not found in ${path}`)
  writeFileSync(path, source.replace(from, to), 'utf8')
}

function prepareWorktree(runRoot) {
  const seed = join(runRoot, 'seed')
  const worktree = join(runRoot, 'forge-worktree')
  mkdirSync(seed)
  checked(REPO, `git archive HEAD | tar -x -C ${JSON.stringify(seed)}`)

  const sourceMcp = join(PLUGIN, 'src/host/local-agents/mcp.js')
  const seedMcp = join(seed, 'ds-bot/src/host/local-agents/mcp.js')
  cpSync(sourceMcp, seedMcp)
  cpSync(join(HERE, 'fixtures'), join(seed, 'ds-bot/test/acceptance/fixtures'), { recursive: true })
  replaceOnce(seedMcp, "    .filter(tool => tool.name.startsWith('mcp__'))\n", '')

  checked(seed, "git init -q && git config user.name 'Reality Gate' && git config user.email 'reality-gate@local' && git add -A && git commit -qm 'Seed MCP inventory drift'")
  const baseline = checked(seed, 'git rev-parse HEAD').stdout.trim()
  checked(seed, `git worktree add --detach ${JSON.stringify(worktree)} HEAD`)
  symlinkSync(join(PLUGIN, 'node_modules'), join(worktree, 'ds-bot/node_modules'), 'dir')

  const baselineText = readFileSync(seedMcp, 'utf8')
  const repairedText = baselineText.replace(
    "  const facts = tools\n    .map(tool => ({",
    "  const facts = tools\n    .filter(tool => tool.name.startsWith('mcp__'))\n    .map(tool => ({",
  )
  return {
    seed,
    worktree,
    baseline,
    baselineText,
    repairedText,
    expectedDiffDigest: diffDigest([{
      path: 'ds-bot/src/host/local-agents/mcp.js',
      oldText: baselineText,
      newText: repairedText,
    }]),
  }
}

function seedState() {
  const bot = (id, name, role) => ({ id, name, role, sessionId: id, createdAt: Date.now() })
  return {
    version: 1,
    mainBotIds: ['chief'],
    bots: {
      chief: bot('chief', 'Chief', 'Coordinator'),
      forge: bot('forge', 'Forge', 'Engineer'),
      prism: bot('prism', 'Prism', 'Reviewer'),
    },
    rooms: {
      r1: {
        id: 'r1', name: 'Reality Gate', members: ['chief', 'forge', 'prism'],
        mode: 'admin', admin: 'chief', named: true, log: [], seq: 0, seen: {},
      },
    },
    agents: {}, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0,
  }
}

function dshTargets() {
  const targets = []
  const seen = new Set()
  const add = (label, kind, path) => {
    if (!existsSync(path)) return
    const real = realpathSync(path)
    const key = `${kind}:${real}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push({ label, kind, path: real })
  }
  const addInstalled = (label, root) => add(label, 'installed-packages', join(root, 'node_modules/@deepseek-ai'))
  const addCheckout = (label, path) => {
    const real = existsSync(path) ? realpathSync(path) : undefined
    if (real === undefined) return
    const top = command(real, 'git rev-parse --show-toplevel')
    if (top.ok && realpathSync(top.stdout.trim()) === real) add(label, 'git-checkout', real)
    else addInstalled(label, real)
  }

  addInstalled('pinned-DSH-install', join(PLUGIN, 'dev', 'harness'))
  addInstalled('plugin-DSH-install', PLUGIN)
  if (process.env.DSH_HARNESS) addCheckout('DSH_HARNESS-install', process.env.DSH_HARNESS)
  const listed = command(REPO, 'git worktree list --porcelain')
  const mainWorktree = listed.stdout.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length)
  if (mainWorktree) addCheckout('shared-DSH-checkout', join(dirname(mainWorktree), 'deepseek-harness'))
  if (targets.length === 0) throw new Error('no DSH checkout or install target was found')
  return targets
}

function startChild(stage, options) {
  const marker = join(options.runRoot, `${stage}.json`)
  const args = {
    stage,
    dshHome: options.home,
    sessionRoot: join(options.home, 'sessions'),
    worktree: options.worktree.worktree,
    marker,
    patchBaseline: options.patchBaseline,
    patchTargets: options.targets,
    checks: options.checks,
  }
  const child = spawn(process.execPath, [
    '--import', './test/harness-resolve.mjs',
    join(HERE, 'fixtures/real-agentloop-host.mjs'),
    JSON.stringify(args),
  ], {
    cwd: PLUGIN,
    env: { ...process.env, DSH_HOME: options.home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return { child, marker, stdout: () => stdout, stderr: () => stderr }
}

async function waitForMarker(run, stage) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (existsSync(run.marker)) {
      const marker = readJson(run.marker)
      if (marker.stage === stage) return marker
      if (marker.stage?.endsWith('timeout')) throw new Error(`child ${run.child.pid} reported ${marker.stage}: ${marker.error}\n${run.stderr()}\n${JSON.stringify(marker, null, 2)}`)
    }
    if (run.child.exitCode !== null) throw new Error(`child ${run.child.pid} exited before its marker\n${run.stderr()}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for child ${run.child.pid}\n${run.stderr()}`)
}

async function stopChild(run, signal = 'SIGTERM') {
  if (run.child.exitCode !== null) return { signal: null, exitCode: run.child.exitCode }
  run.child.kill(signal)
  const exited = await Promise.race([
    new Promise(resolve => run.child.once('exit', (code, status) => resolve({ code, status }))),
    sleep(10_000).then(() => undefined),
  ])
  if (exited === undefined) {
    run.child.kill('SIGKILL')
    await new Promise(resolve => run.child.once('exit', resolve))
    return { signal: 'SIGKILL', exitCode: null }
  }
  return { signal, exitCode: exited.code, processSignal: exited.status }
}

function commandOutput(result) {
  const text = result?.output ?? ''
  return text.startsWith('exit ') ? text.slice(text.indexOf('\n') + 1) : text
}

function parseLastJson(text) {
  const lines = String(text).trim().split('\n').reverse()
  for (const line of lines) {
    try { return JSON.parse(line) } catch {}
  }
  return undefined
}

function typedEvidence(items) {
  return items.map(item => ({
    id: item.id,
    trust: item.trust,
    title: '',
    text: item.command?.outputDigest ?? item.artifact?.path ?? item.diff?.paths?.join(', ') ?? item.summary ?? '',
    sourceId: item.source ?? item.sourceId ?? 'task-ledger',
  }))
}

function toolCallFact(call) {
  let args = call.arguments
  try {
    const parsed = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments
    args = call.name === 'write_file' ? { path: parsed.path } : parsed
  } catch {}
  const diffs = call.meta?.diffs
  return {
    name: call.name,
    arguments: args,
    ok: call.ok,
    exitCode: call.exitCode,
    output: call.output?.slice(0, 2000),
    ...(Array.isArray(diffs) ? { diff: { paths: [...new Set(diffs.map(item => item.path))], digest: diffDigest(diffs) } } : {}),
    ...(call.meta?.artifact === undefined ? {} : { artifact: call.meta.artifact }),
  }
}

function sessionFact(summary) {
  return {
    eventCount: summary.eventCount,
    eventTypes: summary.eventTypes,
    turnsStarted: summary.turnsStarted,
    turnsEnded: summary.turnsEnded,
    toolCalls: summary.toolCalls.map(toolCallFact),
  }
}

export async function runRealityGate() {
  const runRoot = mkdtempSync(join(tmpdir(), 'ds-bot-reality-gate-'))
  const home = join(runRoot, 'dsh-home')
  mkdirSync(home)
  const children = []
  try {
    const worktree = prepareWorktree(runRoot)
    mkdirSync(join(home, 'bot'), { recursive: true })
    writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify(seedState()))
    const targets = dshTargets()
    const patchBaseline = join(runRoot, 'dsh-patch-baseline.json')
    const beforeTargets = await snapshotTargets(targets)
    writeFileSync(patchBaseline, JSON.stringify(beforeTargets, null, 2))

    const repairDiff = {
      id: 'forge-diff',
      kind: 'diff',
      label: 'Forge repaired the actual MCP inventory filter',
      path: 'ds-bot/src/host/local-agents/mcp.js',
      expect: { digest: worktree.expectedDiffDigest },
    }
    const repairCommand = {
      id: 'forge-inventory',
      kind: 'command',
      label: 'MCP inventory behavior after Forge repair',
      command: 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs',
      expect: { exitCode: 0 },
    }
    const checks = {
      repairDiff,
      repairCommand,
      edit: {
        path: 'ds-bot/src/host/local-agents/mcp.js',
        oldText: "  const facts = tools\n    .map(tool => ({",
        newText: "  const facts = tools\n    .filter(tool => tool.name.startsWith('mcp__'))\n    .map(tool => ({",
      },
      diffCheck: 'git diff --check',
      targetedTest: 'node --test test/acceptance/fixtures/mcp-inventory.test.mjs',
      inventory: 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs',
      noPatch: 'node test/acceptance/fixtures/no-dsh-patch.mjs',
      reviewChecks: [
        { id: 'prism-diff', kind: 'diff', label: 'Prism inspected the actual repair diff', path: repairDiff.path, expect: { digest: worktree.expectedDiffDigest } },
        { id: 'prism-diff-check', kind: 'command', label: 'Prism ran git diff --check', command: 'git diff --check', expect: { exitCode: 0 } },
        { id: 'prism-targeted-test', kind: 'command', label: 'Prism ran the targeted MCP inventory test', command: 'node --test test/acceptance/fixtures/mcp-inventory.test.mjs', expect: { exitCode: 0 } },
        { id: 'prism-inventory', kind: 'command', label: 'Prism ran MCP inventory behavior', command: 'node test/acceptance/fixtures/mcp-inventory-e2e.mjs', expect: { exitCode: 0 } },
        { id: 'prism-no-patch', kind: 'command', label: 'Prism proved DSH was not patched', command: 'node test/acceptance/fixtures/no-dsh-patch.mjs', expect: { exitCode: 0 } },
      ],
    }

    const options = { runRoot, home, worktree, patchBaseline, targets, checks }
    const first = startChild('first', options)
    children.push(first)
    const firstReady = await waitForMarker(first, 'first-ready')
    if (firstReady.prismTurnStartsBeforeRestart !== 0) throw new Error(`Prism started before restart: ${JSON.stringify(firstReady)}`)
    if (firstReady.queuedPrismHandoffs !== 1) throw new Error(`Prism handoff was not queued before restart: ${JSON.stringify(firstReady)}`)
    const firstStop = await stopChild(first)

    const second = startChild('second', options)
    children.push(second)
    const secondComplete = await waitForMarker(second, 'second-complete')
    const secondReady = { stage: 'second-started', pid: secondComplete.pid, distinctChildProcess: true }
    const secondStop = await stopChild(second)

    const finalTargets = await snapshotTargets(targets)
    if (JSON.stringify(finalTargets) !== JSON.stringify(beforeTargets)) throw new Error('DSH changed during the Reality Gate run')
    checked(worktree.worktree, 'git diff --check')
    const changedPaths = checked(worktree.worktree, 'git diff --name-only HEAD').stdout.split('\n').filter(Boolean)
    const handoffPath = join(worktree.worktree, 'forge-handoff.json')
    if (!existsSync(handoffPath)) throw new Error(`Forge handoff artifact missing: ${JSON.stringify(secondComplete.forge.summary.toolCalls, null, 2)}`)
    const handoff = readJson(handoffPath)
    const review = readJson(join(worktree.worktree, 'prism-review.json'))
    const state = readJson(join(home, 'bot/state.json'))
    const activity = buildTeamActivity({ state, now: Date.now(), timeZone: 'Asia/Shanghai' })
    const detail = buildTaskDetail({ state, activity, taskId: secondComplete.prism.taskId })

    const prismCalls = secondComplete.prism.summary.toolCalls
    const actualDiffDigest = secondComplete.goal.stages[1].tasks[0].evidence.find(item => item.diff)?.diff?.digest
    const diffCheckCall = prismCalls[1]
    const targetedCall = prismCalls[2]
    const inventoryCall = prismCalls[3]
    const noPatchCall = prismCalls[4]
    const inventoryResult = parseLastJson(commandOutput(inventoryCall))
    const noPatchResult = parseLastJson(commandOutput(noPatchCall))

    if (actualDiffDigest !== worktree.expectedDiffDigest) throw new Error(`Prism did not receive the actual repair diff: ${actualDiffDigest}`)
    if (diffCheckCall?.exitCode !== 0) throw new Error('Prism git diff --check did not pass')
    if (targetedCall?.exitCode !== 0) throw new Error('Prism targeted test did not pass')
    if (inventoryCall?.exitCode !== 0 || inventoryResult?.tools?.length !== 1) throw new Error('Prism MCP inventory check did not pass')
    if (noPatchCall?.exitCode !== 0 || noPatchResult?.dshPatched !== false) throw new Error('Prism no-DSH-patch check did not pass')
    if (secondComplete.prism.pickupCount !== 1) throw new Error(`Prism pickup count was ${secondComplete.prism.pickupCount}`)
    if (secondComplete.prism.taskId !== firstReady.prism.taskId || secondComplete.prism.attemptId !== firstReady.prism.attemptId) throw new Error('Prism task identity changed across restart')
    if (secondComplete.forge.evidence.length === 0) throw new Error('Forge durable evidence did not survive')
    if (secondComplete.goal.status !== 'complete') throw new Error('the Reality Gate goal did not complete from verified evidence')
    if (firstReady.pid === secondReady.pid) throw new Error('the host restart reused the same process')

    const processes = [
      { role: 'first-host', pid: first.child.pid, markerPid: firstReady.pid, distinctChildProcess: true, stoppedBy: firstStop.signal, processSignal: firstStop.processSignal, exitCode: firstStop.exitCode },
      { role: 'second-host', pid: second.child.pid, markerPid: secondReady.pid, distinctChildProcess: true, stoppedBy: secondStop.signal, processSignal: secondStop.processSignal, exitCode: secondStop.exitCode },
    ]
    const stageTitles = secondComplete.goal.stages.map(stage => ({
      title: stage.title,
      owner: stage.tasks[0].botId === 'forge' ? 'Forge' : 'Prism',
      checks: stage.checks.map(check => check.id),
    }))
    const allEvidence = secondComplete.goal.stages.flatMap(stage => stage.tasks.flatMap(task => task.evidence ?? []))

    return {
      schema: 3,
      scenario: 'chief-forge-prism-mcp-repair',
      generatedAt: new Date().toISOString(),
      outcome: 'agentloop-verified',
      mocking: 'deterministic-local-model-transport-only',
      agentLoop: {
        executed: true,
        mode: 'production-dsh-agentloop',
        testkit: '@deepseek-ai/dsh-agent-loop-testkit@0.2.2-rc.1',
        sessionEvents: 'real-dsh-session-events',
        modelTransport: 'deterministic-local-adapter',
        persistence: '@deepseek-ai/dsh-session-persistence-jsonl',
        processBoundary: 'real-child-process-restart',
        events: {
          chief: secondComplete.chief.summary.eventTypes,
          forge: secondComplete.forge.summary.eventTypes,
          prism: secondComplete.prism.summary.eventTypes,
        },
        sessions: Object.fromEntries(Object.entries(secondComplete.agentLoop.sessions).map(([id, summary]) => [id, sessionFact(summary)])),
      },
      followUpGate: {
        required: true,
        status: 'passed',
        scenarioPassed: true,
        proves: [
          'production DSH AgentLoop turns and durable Session events',
          'real DSH tool dispatch for DS Bot goal, handoff and review tools',
          'same isolated DSH_HOME across two OS child processes',
          'same Prism task and attempt identity with one post-restart pickup',
        ],
      },
      chief: {
        role: 'Coordinator',
        view: 'Reality Gate',
        goal: { id: secondComplete.goal.id, createdByTool: 'group_goal', status: secondComplete.goal.status, verification: secondComplete.goal.verification },
        stages: stageTitles,
        definitionOfDone: 'Forge returns a durable repair; Prism verifies the actual diff, MCP inventory behavior, targeted tests and the no-DSH-patch invariant through real tool calls.',
      },
      forge: {
        role: 'Engineer',
        taskId: secondComplete.forge.taskId,
        attemptId: secondComplete.forge.attemptId,
        worktree: {
          isolated: true,
          baselineCommit: worktree.baseline,
          changedPaths,
        },
        handoff,
        evidence: secondComplete.forge.evidence,
        toolCalls: secondComplete.forge.summary.toolCalls.map(toolCallFact),
      },
      prism: {
        role: 'Reviewer',
        taskId: secondComplete.prism.taskId,
        attemptId: secondComplete.prism.attemptId,
        pickupCount: secondComplete.prism.pickupCount,
        recovery: secondComplete.prism.recovery,
        toolCalls: prismCalls.length,
        tools: prismCalls.map(toolCallFact),
        checks: {
          diff: { verified: actualDiffDigest === worktree.expectedDiffDigest, result: { path: repairDiff.path, digest: actualDiffDigest } },
          diffCheck: { verified: diffCheckCall.exitCode === 0, command: checks.diffCheck, exitCode: diffCheckCall.exitCode },
          tests: { verified: targetedCall.exitCode === 0, command: checks.targetedTest, exitCode: targetedCall.exitCode, result: commandOutput(targetedCall) },
          inventory: { verified: inventoryCall.exitCode === 0 && inventoryResult.tools.length === 1, command: checks.inventory, result: inventoryResult },
          noDshPatch: { verified: noPatchCall.exitCode === 0 && noPatchResult.dshPatched === false, command: checks.noPatch, result: noPatchResult },
        },
        review,
      },
      restart: {
        boundary: 'after-forge-durable-result-before-prism-pickup',
        hostStarts: 2,
        sameDshHome: true,
        processes,
        sameTaskId: secondComplete.prism.taskId === firstReady.prism.taskId,
        sameAttemptId: secondComplete.prism.attemptId === firstReady.prism.attemptId,
        queuedBeforeRestart: firstReady.queuedPrismHandoffs === 1,
        queuedPrismHandoffs: firstReady.queuedPrismHandoffs,
        prismSessionExistedBeforeRestart: firstReady.prismSessionExistedBeforeRestart,
        prismTurnStartsBeforeRestart: firstReady.prismTurnStartsBeforeRestart,
        prismPickupsBeforeRestart: 0,
        prismPickupsAfterRestart: secondComplete.prism.pickupCount,
        recoveryKind: secondComplete.prism.recovery[0]?.kind ?? null,
        forgeEvidenceBeforeRestart: firstReady.forge.evidence.map(item => ({ id: item.id, attemptId: item.attemptId, trust: item.trust })),
        forgeEvidenceAfterRestart: secondComplete.forge.evidence.map(item => ({ id: item.id, attemptId: item.attemptId, trust: item.trust })),
      },
      dshInvariant: {
        checkedAt: 'after-second-host',
        dshPatched: false,
        targets: noPatchResult.targets,
      },
      detail,
      verification: {
        status: secondComplete.goal.verification?.state === 'verified' ? 'verified' : 'failed',
        reason: 'Every required stage check is bound to durable AgentLoop tool evidence; the goal completed only after Prism verified them.',
      },
      typedEvidence: typedEvidence(allEvidence),
      mockSeams: [
        'a deterministic local model adapter chooses the model requests; the DSH AgentLoop, Session events and tool dispatch are real',
        'the synthetic Git repository and its worktree are created under the OS temp directory',
        'the temporary DSH_HOME contains only this acceptance run and is removed at the end',
        'external model APIs, paid operations, the user DSH profile and deployment are not used',
      ],
      limitations: [
        'The model transport is deterministic rather than a paid production model; tool choice is scripted by the local adapter.',
        'Production Desktop/Web rendering, deployment, payment and external-message paths are outside this scenario.',
        'The shared DSH checkout may already contain user changes; the proof records tracked and untracked state and verifies the run introduced no delta.',
        'No commit, push, deployment, external message, permission change or paid operation is performed by the scenario.',
      ],
    }
  } finally {
    for (const run of children) {
      if (run.child.exitCode === null) {
        run.child.kill('SIGKILL')
        await Promise.race([new Promise(resolve => run.child.once('exit', resolve)), sleep(2000)])
      }
    }
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}
