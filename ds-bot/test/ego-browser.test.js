import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm, mkdir, readFile, readdir, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findEgoCli } from '../src/host/browser/ego/detect.js'
import { buildScript, runEgoScript, RESULT_SENTINEL, ERROR_SENTINEL } from '../src/host/browser/ego/script.js'
import { actionBody, createRunner, egoProfileName, egoSpaceName, pruneShots, toolDefs } from '../src/host/browser/ego/tools.js'
import { linkedToOtherBot, profileForBot, requestedProfileName, storedProfileId } from '../src/host/browser/ego/profiles.js'
import { EgoLease } from '../src/host/browser/ego/lease.js'
import { auditUrl, parseWebUrl, paymentLike } from '../src/host/browser/ego/policy.js'
import { appendAudit } from '../src/host/browser/ego/audit.js'

test('ego: the CLI is found through ANBOT_EGO_CLI and PATH', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anbot-ego-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cli = join(dir, 'ego-browser')
  await writeFile(cli, '#!/bin/sh\n')
  await chmod(cli, 0o755)
  assert.equal(findEgoCli({ env: { ANBOT_EGO_CLI: cli, PATH: '' }, home: dir }), cli)
  assert.equal(findEgoCli({ env: { PATH: dir }, home: dir }), cli)
})

test('ego: a script carries the Bot space and an explicit profile', () => {
  const script = buildScript({
    space: egoSpaceName({ name: '小安' }),
    profileId: 'profile-3',
    profileName: egoProfileName({ name: '小安' }),
    body: 'return 1',
  })
  assert.match(script, /Anbot · 小安/)
  assert.match(script, /profile-3/)
  assert.match(script, /profiles\(\)/)
  assert.match(script, /taskSpace\(spaceName, \{ profileId: profile\.id \}\)/)
  assert.match(script, /EGO_PROFILE_MISSING/)
  assert.doesNotMatch(script, /taskSpace\(spaceName, profile \?/)
})

test('ego: profile and space names stay readable and overridable', () => {
  assert.equal(egoProfileName({ name: '小安' }), 'Anbot · 小安')
  assert.equal(egoProfileName({ name: '小安', browserEgoProfile: 'Profile 3' }), 'Profile 3')
  assert.equal(egoSpaceName({ name: '小安' }), 'Anbot · 小安')
})

test('ego: a linked profile survives a Bot rename, an explicit setting wins', () => {
  const stored = { profileId: 'profile-9', profileName: 'Anbot · 旧名字' }
  assert.deepEqual(profileForBot({ id: 'b1', name: '新名字' }, stored), { profileName: 'Anbot · 旧名字', profileId: 'profile-9' })
  assert.deepEqual(profileForBot({ id: 'b1', name: '新名字', browserEgoProfile: 'Profile 3' }, stored), { profileName: 'Profile 3', profileId: undefined })
  assert.equal(storedProfileId(stored, 'Anbot · 旧名字'), 'profile-9')
  assert.equal(storedProfileId(stored, 'Anbot · 新名字'), undefined)
  assert.equal(requestedProfileName({ name: '小安' }), 'Anbot · 小安')
})

test('ego: a default profile name is not inherited by a recycled Bot name', () => {
  const map = { b1: { profileId: 'p1', profileName: 'Anbot · 小安' } }
  assert.equal(linkedToOtherBot(map, 'Anbot · 小安', 'b2'), 'b1')
  assert.equal(linkedToOtherBot(map, 'Anbot · 小安', 'b1'), undefined)
  // Explicit sharing is allowed; the setting is the user's decision.
  assert.deepEqual(profileForBot({ id: 'b2', name: '小安', browserEgoProfile: 'Anbot · 小安' }, undefined), {
    profileName: 'Anbot · 小安',
    profileId: undefined,
  })
})

test('ego: results and errors come back through the sentinels', async () => {
  const ok = await runEgoScript('/bin/ego-browser', 'script', {
    run: async () => ({ stdout: `noise\n${RESULT_SENTINEL}{"spaceId":7,"profileId":"Profile 3","value":"snapshot text"}\n`, stderr: '' }),
  })
  assert.deepEqual(ok, { ok: true, result: { spaceId: 7, profileId: 'Profile 3', value: 'snapshot text' } })

  const failed = await runEgoScript('/bin/ego-browser', 'script', {
    run: async () => ({ stdout: `${ERROR_SENTINEL}{"code":"EGO_PROFILE_MISSING","message":"no profile"}\n`, stderr: '' }),
  })
  assert.equal(failed.ok, false)
  assert.equal(failed.code, 'EGO_PROFILE_MISSING')
  assert.match(failed.error, /no profile/)

  const crashed = await runEgoScript('/bin/ego-browser', 'script', {
    run: async () => { throw Object.assign(new Error('spawn failed'), { stdout: '', stderr: 'ego lite is not running' }) },
  })
  assert.equal(crashed.ok, false)
  assert.match(crashed.error, /not running/)
})

test('ego: structured actions return a fresh snapshot after acting', () => {
  assert.match(actionBody('click', { selector: '@12' }), /page\.click/)
  assert.match(actionBody('click', { selector: '@12' }), /page\.snapshot/)
  assert.match(actionBody('type', { selector: '@3', text: 'hello', submit: true }), /page\.fill/)
  assert.match(actionBody('type', { selector: '@3', text: 'hello', submit: true }), /page\.press/)
  assert.deepEqual(toolDefs().map(tool => tool.name), [
    'ego_status', 'ego_open', 'ego_snapshot', 'ego_click', 'ego_type', 'ego_press', 'ego_screenshot', 'ego_run', 'ego_handoff', 'ego_resume',
  ])
})

test('ego: a recycled Bot name cannot take another Bot profile', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anbot-ego-shared-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'ego-profiles.json'), JSON.stringify({
    b1: { profileId: 'p1', profileName: 'Anbot · 小安' },
  }))
  const bot = { id: 'b2', name: '小安' }
  const rt = { home: dir, botOf: id => (id === 'b2' ? bot : undefined), config: {}, egoBrowser: {} }
  const perform = createRunner({
    rt,
    cli: '/bin/ego-browser',
    host: { resolveBotId: async () => 'b2' },
    lease: new EgoLease(),
    authorize: async () => {},
  })
  await assert.rejects(() => perform('snapshot', {}, {}), (error) => {
    assert.equal(error.code, 'EGO_PROFILE_SHARED')
    assert.match(error.message, /already linked/)
    return true
  })
})

test('ego: URLs and payments are refused before any page action', () => {
  assert.equal(parseWebUrl('https://example.com/a?b=1').href, 'https://example.com/a?b=1')
  assert.throws(() => parseWebUrl('file:///etc/passwd'), /http/)
  assert.throws(() => parseWebUrl('https://user:pass@example.com/'), /credentials/)
  assert.equal(paymentLike('Pay now'), true)
  assert.equal(paymentLike('付款'), true)
  assert.equal(paymentLike('Search'), false)
  assert.equal(auditUrl('https://example.com/a?token=secret#x'), 'https://example.com/a')
  assert.equal(auditUrl('not a url'), '')
})

test('ego: one driver at a time, and the user always wins', () => {
  let now = 1000
  const lease = new EgoLease({ now: () => now, userHoldMs: 60_000, botLeaseMs: 120_000 })
  assert.equal(lease.beginBot('b1', 'call-1').ok, true)
  assert.equal(lease.beginBot('b1', 'call-2').ok, false)
  lease.endBot('b1', 'call-1')
  assert.equal(lease.owner('b1'), null)
  lease.takeUser('b1')
  assert.equal(lease.owner('b1'), 'user')
  assert.equal(lease.beginBot('b1', 'call-3').owner, 'user')
  now += 61_000
  assert.equal(lease.owner('b1'), null)
  lease.takeUser('b1', { indefinite: true })
  now += 600_000
  assert.equal(lease.owner('b1'), 'user')
  lease.resume('b1')
  assert.equal(lease.owner('b1'), null)
})

test('ego: audit keeps metadata, drops query parameters, and rotates', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anbot-ego-audit-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await appendAudit(dir, 'bot/1', {
    tool: 'ego_open', action: 'open', outcome: 'ok', url: 'https://example.com/a?token=secret',
    profileId: 'p1', profileName: 'Anbot · 小安', shared: true, target: '@12', reason: 'test', durationMs: 5,
  })
  const path = join(dir, 'ego-audit', 'bot_1.jsonl')
  const line = JSON.parse((await readFile(path, 'utf8')).trim())
  assert.equal(line.url, 'https://example.com/a')
  assert.equal(line.profileId, 'p1')
  assert.equal(line.shared, true)
  assert.equal(line.target, '@12')
  assert.equal(line.reason, 'test')
  assert.equal(line.durationMs, 5)
})

test('ego: screenshots on disk stay bounded', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anbot-ego-shots-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await mkdir(dir, { recursive: true })
  for (let index = 0; index < 25; index += 1) {
    const path = join(dir, `${String(index).padStart(2, '0')}.png`)
    await writeFile(path, 'x')
    const time = new Date(2026, 0, 1, 0, 0, index)
    await utimes(path, time, time)
  }
  const removed = await pruneShots(dir, 3)
  assert.equal(removed, 22)
  assert.deepEqual((await readdir(dir)).sort(), ['22.png', '23.png', '24.png'])
})

test('ego: the provider registers into the browser slot and only defaults in the app', async (t) => {
  const { installEgo } = await import('../src/host/browser/ego/index.js')
  const previousApp = process.env.DS_BOT_APP
  delete process.env.DS_BOT_APP
  t.after(() => { if (previousApp !== undefined) process.env.DS_BOT_APP = previousApp })
  const registered = []
  const rt = {
    config: {},
    home: '/tmp',
    plugins: { registerBuiltin: desc => registered.push(desc) },
    botOf: () => undefined,
  }
  assert.equal(installEgo(rt, { findEgoCli: () => '/bin/ego-browser', findEgoApp: () => undefined }), true)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].id, 'builtin:ego')
  assert.equal(registered[0].slot, 'browser')
  assert.equal(registered[0].supportsGrants, true)
  assert.deepEqual(registered[0].toolPrefixes, [
    'ego_status', 'ego_open', 'ego_snapshot', 'ego_click', 'ego_type', 'ego_press', 'ego_screenshot', 'ego_run', 'ego_handoff', 'ego_resume',
  ])
  assert.equal(rt.egoBrowser.available, true)
  assert.equal(rt.defaultBrowserTarget(), null)

  const app = { config: {}, home: '/tmp', plugins: { registerBuiltin: () => {} } }
  process.env.DS_BOT_APP = '1'
  installEgo(app, { findEgoCli: () => '/bin/ego-browser', findEgoApp: () => undefined })
  assert.equal(app.defaultBrowserTarget(), 'builtin:ego')

  const off = { config: {}, home: '/tmp', plugins: { registerBuiltin: desc => registered.push(desc) }, botOf: () => undefined }
  assert.equal(installEgo(off, { findEgoCli: () => undefined, findEgoApp: () => undefined }), false)
  assert.equal(off.egoBrowser.available, false)
  assert.equal(off.defaultBrowserTarget(), null)
  assert.deepEqual(registered.at(-1).toolPrefixes, ['ego_status'])
})

test('ego: the driver carries the loopback port, token, and profile', async () => {
  const { buildDriver } = await import('../src/host/browser/ego/bridge.js')
  const script = buildDriver({ space: 'Anbot · 小安', profileId: 'p1', profileName: 'Anbot · 小安', port: 41234, token: 'secret-token' })
  assert.match(script, /port: 41234/)
  assert.match(script, /secret-token/)
  assert.match(script, /profileId: profile\.id/)
  assert.match(script, /EGO_PROFILE_MISSING/)
  assert.match(script, /Page\.captureScreenshot/)
  assert.match(script, /Input\.dispatchMouseEvent/)
  assert.match(script, /taskSpace\(spaceName, \{ profileId: profile\.id \}\)/)
})

test('ego: the bridge keeps the newest frame and wakes a waiter', async () => {
  const { EgoBridge } = await import('../src/host/browser/ego/bridge.js')
  const bridge = new EgoBridge({ cli: '/bin/ego-browser', space: 'Anbot · 小安', profileId: 'p1' })
  const waiting = bridge.waitForFrame(undefined, 1000)
  bridge._onLine(JSON.stringify({ type: 'ready', token: bridge.token, spaceId: 3, profileId: 'p1', profileName: 'Anbot · 小安' }))
  bridge._onLine(JSON.stringify({ type: 'frame', token: bridge.token, seq: 1, data: 'aGk=', width: 100, height: 50, url: 'https://example.com', title: 'Example' }))
  const frame = await waiting
  assert.equal(frame.seq, 1)
  assert.equal(frame.url, 'https://example.com')
  assert.equal(bridge.latest().data, 'aGk=')
  bridge._onLine(JSON.stringify({ type: 'frame', token: 'wrong', seq: 2, data: 'no' }))
  assert.equal(bridge.latest().seq, 1)
  bridge.stop()
})

test('ego: the bridge reports a fatal driver message as an error', async () => {
  const { EgoBridge } = await import('../src/host/browser/ego/bridge.js')
  const bridge = new EgoBridge({ cli: '/bin/ego-browser', space: 'Anbot · 小安', profileId: 'p1' })
  bridge._onLine(JSON.stringify({ type: 'fatal', token: bridge.token, code: 'EGO_PROFILE_MISSING', message: 'no profile' }))
  assert.match(bridge.error, /no profile/)
  assert.equal(bridge.errorCode, 'EGO_PROFILE_MISSING')
  bridge.stop()
})
