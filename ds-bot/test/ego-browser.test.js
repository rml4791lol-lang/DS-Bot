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
