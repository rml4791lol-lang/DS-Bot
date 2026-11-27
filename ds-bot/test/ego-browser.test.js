import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findEgoCli } from '../src/host/browser/ego/detect.js'
import { buildScript, runEgoScript, RESULT_SENTINEL, ERROR_SENTINEL } from '../src/host/browser/ego/script.js'
import { actionBody, egoProfileName, egoSpaceName, toolDefs } from '../src/host/browser/ego/tools.js'

test('ego: the CLI is found through ANBOT_EGO_CLI and PATH', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anbot-ego-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const cli = join(dir, 'ego-browser')
  await writeFile(cli, '#!/bin/sh\n')
  await chmod(cli, 0o755)
  assert.equal(findEgoCli({ env: { ANBOT_EGO_CLI: cli, PATH: '' }, home: dir }), cli)
  assert.equal(findEgoCli({ env: { PATH: dir }, home: dir }), cli)
})

test('ego: a script carries the Bot space and its profile', () => {
  const script = buildScript({
    space: egoSpaceName({ name: '小安' }),
    profileName: egoProfileName({ name: '小安' }),
    body: 'return 1',
  })
  assert.match(script, /Anbot · 小安/)
  assert.match(script, /profiles\(\)/)
  assert.match(script, /taskSpace\(spaceName/)
  assert.match(script, /task\.pages\(\)/)
})

test('ego: profile and space names stay readable and overridable', () => {
  assert.equal(egoProfileName({ name: '小安' }), 'Anbot · 小安')
  assert.equal(egoProfileName({ name: '小安', browserEgoProfile: 'Profile 3' }), 'Profile 3')
  assert.equal(egoSpaceName({ name: '小安' }), 'Anbot · 小安')
})

test('ego: results and errors come back through the sentinels', async () => {
  const ok = await runEgoScript('/bin/ego-browser', 'script', {
    run: async () => ({ stdout: `noise\n${RESULT_SENTINEL}{"spaceId":7,"profileId":"Profile 3","value":"snapshot text"}\n`, stderr: '' }),
  })
  assert.deepEqual(ok, { ok: true, result: { spaceId: 7, profileId: 'Profile 3', value: 'snapshot text' } })

  const failed = await runEgoScript('/bin/ego-browser', 'script', {
    run: async () => ({ stdout: `${ERROR_SENTINEL}{"message":"EGO_PAGE_UNRESPONSIVE"}\n`, stderr: '' }),
  })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /EGO_PAGE_UNRESPONSIVE/)

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
    'ego_open', 'ego_snapshot', 'ego_click', 'ego_type', 'ego_press', 'ego_screenshot', 'ego_run',
  ])
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
  assert.deepEqual(registered[0].toolPrefixes, ['ego_open', 'ego_snapshot', 'ego_click', 'ego_type', 'ego_press', 'ego_screenshot', 'ego_run'])
  assert.equal(rt.egoBrowser.available, true)
  assert.equal(rt.defaultBrowserTarget(), null)

  const off = { config: {}, home: '/tmp', plugins: { registerBuiltin: () => {} } }
  assert.equal(installEgo(off, { findEgoCli: () => undefined, findEgoApp: () => undefined }), false)
  assert.equal(off.defaultBrowserTarget, undefined)
})

test('ego: the driver carries the loopback port and token', async () => {
  const { buildDriver } = await import('../src/host/browser/ego/bridge.js')
  const script = buildDriver({ space: 'Anbot · 小安', profileName: 'Anbot · 小安', port: 41234, token: 'secret-token' })
  assert.match(script, /port: 41234/)
  assert.match(script, /secret-token/)
  assert.match(script, /Page\.captureScreenshot/)
  assert.match(script, /Input\.dispatchMouseEvent/)
  assert.match(script, /taskSpace\(spaceName/)
})

test('ego: the bridge keeps the newest frame and wakes a waiter', async () => {
  const { EgoBridge } = await import('../src/host/browser/ego/bridge.js')
  const bridge = new EgoBridge({ cli: '/bin/ego-browser', space: 'Anbot · 小安' })
  const waiting = bridge.waitForFrame(undefined, 1000)
  bridge._onLine(JSON.stringify({ type: 'ready', token: bridge.token, spaceId: 3, profileId: null, profileName: null }))
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
  const bridge = new EgoBridge({ cli: '/bin/ego-browser', space: 'Anbot · 小安' })
  bridge._onLine(JSON.stringify({ type: 'fatal', token: bridge.token, message: 'EGO_NOT_RUNNING' }))
  assert.match(bridge.error, /EGO_NOT_RUNNING/)
  bridge.stop()
})
