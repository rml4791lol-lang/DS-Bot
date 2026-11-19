// A real DSH skill registry, filesystem provider and skill tool, not a fake
// catalog: an Agent-scoped mask must remove a profile skill from the model
// catalog and make a direct `skill` call fail, while a symbolic-link skill
// remains selectable.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as FsSkill from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { createRuntime } from '../index.js'
import { skillMaskPreStepGate } from '../src/host/capabilities.js'
import { fakeContext } from './fake-ctx.js'

function writeSkill(root, name, body = name) {
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${body}\n`)
}

// A runtime whose only job is to own the production applySkillMasks. The mask then
// lands in the real Agent scope through src/host/capabilities.js; a test-local
// register() call would prove DSH semantics but never this code path.
function maskRuntimeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-skill-mask-rt-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['s1'],
    bots: { s1: { id: 's1', sessionId: 's1', name: 'Chief', capabilities: [], createdAt: 1 } },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    revision: 1,
  }))
  return home
}

async function mountMaskRuntime(t, skills) {
  const home = maskRuntimeHome()
  const loader = {
    import: async () => ({ default: { name: 'mcp-client', apply() {} } }),
    unwrapExports: exports => exports.default,
  }
  // The host provider layer is what cordis.patch.yml mounts in production; the real
  // registry is exposed here so listProfileSkills reads the catalog the Agent sees.
  const fake = fakeContext({ services: { loader, skills } })
  const runtime = createRuntime(fake, { home, github: false, diagnosticsFile: false })
  runtime.resolveAgent = async () => undefined
  await runtime.load()
  t.after(async () => {
    fake.dispose()
    await runtime.scheduleCapabilitiesReconcile()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return runtime
}

test('the real DSH catalog and skill tool obey an Agent-scoped shortlist mask', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-skill-runtime-'))
  const external = join(root, 'external-linked')
  mkdirSync(external)
  writeFileSync(join(external, 'SKILL.md'), '---\nname: linked\ndescription: linked skill\n---\n\nLINKED BODY\n')
  for (let index = 0; index < 5; index += 1) writeSkill(root, `skill-${index}`, `BODY ${index}`)
  symlinkSync(external, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: {} })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FsSkill, { includeDefaultRoots: false, customSkillDirs: [root], watch: false })
  await ctx.plugin(ToolSkill)
  await mountAgentLoopTestHarness(ctx)
  const runtime = await mountMaskRuntime(t, ctx.skills)
  const agent = await ctx.agentLoop.create(SessionId('s1'), {})
  const all = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(all, ['linked', 'skill-0', 'skill-1', 'skill-2', 'skill-3', 'skill-4'])

  const chosen = ['linked', 'skill-0', 'skill-1', 'skill-2', 'skill-3']
  const bot = {
    ...runtime.state.bots.s1,
    skillShortlist: chosen.map(name => ({ name, purpose: `use ${name} when the task calls for it` })),
  }
  // The production path: capabilities.js builds the mask and mounts it in the Agent
  // scope. Flipping modelInvocable at capabilities.js:339 must turn this test red.
  await runtime.applySkillMasks(agent, bot)
  const visible = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(visible, chosen)

  const tool = ctx.tools.get('skill', agent)
  const exec = { agent, signal: new AbortController().signal }
  assert.match((await tool.execute({ name: 'linked' }, exec)).content, /LINKED BODY/)
  await assert.rejects(() => tool.execute({ name: 'skill-4' }, exec), /not available for model invocation/)
  const hidden = await ctx.skills.get('skill-4', { cwd: root, scope: agent })
  assert.equal(hidden.invocation.userInvocable, false)
  assert.equal(hidden.invocation.modelInvocable, false)

  // A symbolic-link skill goes through the same mask: excluding it from the
  // shortlist must hide it exactly like a plain skill directory.
  const withoutLink = chosen.slice(1).concat('skill-4')
  await runtime.applySkillMasks(agent, {
    ...bot,
    skillShortlist: withoutLink.map(name => ({ name, purpose: `use ${name} when the task calls for it` })),
  })
  const linked = await ctx.skills.get('linked', { cwd: root, scope: agent })
  assert.equal(linked.invocation.userInvocable, false)
  assert.equal(linked.invocation.modelInvocable, false)
  await assert.rejects(() => tool.execute({ name: 'linked' }, exec), /not available for model invocation/)

  await runtime.applySkillMasks(agent, { ...bot, skillShortlist: undefined })
  const restored = (await ctx.skills.snapshot({ cwd: root, scope: agent })).skills
    .filter(skill => skill.invocation.modelInvocable)
    .map(skill => skill.name)
    .sort()
  assert.deepEqual(restored, all)
})

test('a strict-mask failure rejects a real DSH /name invocation but leaves ordinary text alone', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ds-bot-skill-gesture-'))
  writeSkill(root, 'hidden', 'HIDDEN BODY')

  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 5 })
  })
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: {} })
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(FsSkill, { includeDefaultRoots: false, customSkillDirs: [root], watch: false })
  await ctx.plugin(ToolSkill)
  await mountAgentLoopTestHarness(ctx)
  const agent = await ctx.agentLoop.create(SessionId('s-gate'), {})
  const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const propose = async text => {
    const input = message(text)
    return agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { modelSelection: { provider: 'mock', model: 'mock' }, messages: [input], turn: 1, step: 1, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [input] }),
    )
  }

  // DSH itself injects the body on `/hidden`; this is the bypass the tool denial
  // cannot close. The capabilities gate is then layered over the real listener.
  const invoked = await propose('/hidden')
  assert.equal(invoked.kind, 'enter')
  assert.equal(invoked.messages.some(item => item.source.kind === 'skill-invocation' && item.source.name === 'hidden'), true)

  const unavailable = new WeakSet()
  const gate = ctx.plugin({
    name: 'test-strict-mask-gate',
    apply(c) { c.on('agent/pre-step', skillMaskPreStepGate(unavailable)) },
  })
  await gate.await()
  assert.equal((await propose('ordinary text')).kind, 'enter')
  unavailable.add(agent)
  assert.deepEqual(await propose('/hidden'), { kind: 'reject' })
  assert.equal((await propose('ordinary text')).kind, 'enter')
})
