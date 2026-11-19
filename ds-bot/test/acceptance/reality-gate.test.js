import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { runRealityGate } from './reality-gate.mjs'

test('Reality Gate proves Chief, Forge, restart, then one Prism review with typed evidence', async () => {
  const result = await runRealityGate()
  const output = fileURLToPath(new URL('./reality-gate-evidence.json', import.meta.url))
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`)

  assert.equal(result.schema, 3)
  assert.equal(result.scenario, 'chief-forge-prism-mcp-repair')
  assert.equal(result.outcome, 'agentloop-verified')
  assert.deepEqual([result.agentLoop.executed, result.agentLoop.testkit], [true, '@deepseek-ai/dsh-agent-loop-testkit@0.2.2-rc.1'])
  assert.equal(result.agentLoop.sessionEvents, 'real-dsh-session-events')
  assert.equal(result.agentLoop.modelTransport, 'deterministic-local-adapter')
  assert.deepEqual([result.followUpGate.required, result.followUpGate.status, result.followUpGate.scenarioPassed], [true, 'passed', true])
  assert.equal(result.chief.stages.length, 2)
  assert.deepEqual(result.chief.stages.map(stage => stage.owner), ['Forge', 'Prism'])
  assert.equal(result.forge.worktree.isolated, true)
  assert.deepEqual(result.forge.handoff.changedPaths, ['ds-bot/src/host/local-agents/mcp.js'])
  assert.ok(result.forge.handoff.commands.length >= 2)
  assert.match(result.forge.handoff.limitations, /deterministic local model transport/i)
  assert.equal(result.restart.boundary, 'after-forge-durable-result-before-prism-pickup')
  assert.equal(result.restart.hostStarts, 2)
  assert.notEqual(result.restart.processes[0].pid, result.restart.processes[1].pid)
  assert.ok(result.restart.processes.every(process => process.distinctChildProcess === true))
  assert.ok(result.restart.processes.every(process => process.stoppedBy === 'SIGTERM'))
  assert.equal(result.restart.prismTurnStartsBeforeRestart, 0)
  assert.equal(result.restart.prismSessionExistedBeforeRestart, true)
  assert.deepEqual({
    sameTaskId: result.restart.sameTaskId,
    sameAttemptId: result.restart.sameAttemptId,
    queuedBeforeRestart: result.restart.queuedBeforeRestart,
    prismPickupsBeforeRestart: result.restart.prismPickupsBeforeRestart,
    prismPickupsAfterRestart: result.restart.prismPickupsAfterRestart,
    recoveryKind: result.restart.recoveryKind,
  }, {
    sameTaskId: true,
    sameAttemptId: true,
    queuedBeforeRestart: true,
    prismPickupsBeforeRestart: 0,
    prismPickupsAfterRestart: 1,
    recoveryKind: 'resent',
  })
  assert.equal(result.prism.checks.diff.verified, true)
  assert.equal(result.prism.checks.inventory.verified, true)
  assert.equal(result.prism.checks.tests.verified, true)
  assert.equal(result.prism.checks.noDshPatch.verified, true)
  assert.equal(result.verification.status, 'verified')
  assert.equal(result.detail.attempt.id, result.prism.attemptId)
  assert.equal(result.detail.owner.role, 'Reviewer')
  assert.equal(result.detail.location.stageTitle, 'Review')
  assert.equal(result.detail.handoff, null)
  assert.equal(result.detail.recovery.records[0].attemptId, result.prism.attemptId)
  assert.ok(result.typedEvidence.every(item => ['reported', 'executed', 'verified'].includes(item.trust)))
  assert.ok(result.typedEvidence.filter(item => item.trust === 'verified').length >= 7)
  assert.ok(result.mockSeams.some(item => /deterministic local model adapter/i.test(item)))
  assert.equal(result.chief.goal.createdByTool, 'group_goal')
  assert.notEqual(result.forge.taskId, result.prism.taskId)
  assert.ok(result.prism.toolCalls >= 4)
  assert.deepEqual(result.prism.tools.map(call => call.name), ['git_diff', 'bash', 'bash', 'bash', 'bash', 'write_file'])
  assert.deepEqual(result.prism.tools.slice(1, 5).map(call => call.arguments.command), [
    'git diff --check',
    'node --test test/acceptance/fixtures/mcp-inventory.test.mjs',
    'node test/acceptance/fixtures/mcp-inventory-e2e.mjs',
    'node test/acceptance/fixtures/no-dsh-patch.mjs',
  ])
  assert.equal(result.prism.checks.noDshPatch.result.dshPatched, false)
  assert.ok(result.prism.checks.noDshPatch.result.targets.length >= 1)
  assert.ok(result.dshInvariant.targets.every(target => target.unchanged === true))
  const installedDsh = result.dshInvariant.targets.find(target => target.kind === 'installed-packages')
  const dshCheckout = result.dshInvariant.targets.find(target => target.kind === 'git-checkout')
  assert.ok(installedDsh, 'the pinned DSH install is checked')
  assert.ok(dshCheckout, 'the shared DSH checkout is checked')
  assert.ok(installedDsh.files > 0)
  assert.ok(Array.isArray(dshCheckout.untrackedFiles))
  assert.match(dshCheckout.trackedDiffDigest, /^sha256:/)
})
