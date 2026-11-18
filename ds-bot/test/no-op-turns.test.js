import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyInternalNoOpTurns } from '../src/host/no-op-turns.js'

const start = (turn = 1) => ({ type: 'turn/start', data: { turn } })
const user = (kind = 'schedule', turn) => ({ type: 'user/message', data: { ...(turn === undefined ? {} : { turn }), source: { kind } } })
const say = (text, extra = [], turn) => ({ type: 'assistant/message', data: { ...(turn === undefined ? {} : { turn }), message: { content: [{ type: 'text', text }, ...extra] } } })
const end = (turn = 1, kind = 'completed') => ({ type: 'turn/end', data: { turn, reason: { kind } } })

test('a scheduled acknowledgement-only turn is internal', () => {
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), say('（无动作）'), end()]), [1])
})

test('coordinator no-op lines are internal too', () => {
  for (const text of ['无需操作。', '当前没有需要向你汇报的内容。', '本次没有需要回复的内容。', '本次巡检无变化。']) {
    assert.deepEqual(classifyInternalNoOpTurns([start(), user(), say(text), end()]), [1], text)
  }
})

test('a user no-change answer and a scheduled completion stay visible', () => {
  assert.deepEqual(classifyInternalNoOpTurns([start(1), user('user', 1), say('无新变化，本轮不报告。', [], 1), end(1)]), [])
  assert.deepEqual(classifyInternalNoOpTurns([start(2), user('schedule', 2), say('done', [], 2), end(2)]), [])
})

test('completion work, an attachment, or an unknown trigger stays visible', () => {
  const tool = { type: 'tool/call', data: { turn: 1 } }
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), tool, say('done'), end()]), [])
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), say('', [{ type: 'image', attachment: {} }]), end()]), [])
  assert.deepEqual(classifyInternalNoOpTurns([start(), { type: 'user/message', data: {} }, say('（无动作）'), end()]), [])
})

test('an acknowledgement stays internal even when the Bot read its inbox first', () => {
  const tool = { type: 'tool/call', data: { turn: 1 } }
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), tool, say('（本轮无新变化，不输出内容。）'), end()]), [1])
})

test('a failed or stopped turn is never hidden', () => {
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), say('（无动作）'), end(1, 'error')]), [])
  assert.deepEqual(classifyInternalNoOpTurns([start(), user(), say('（无动作）'), end(1, 'aborted')]), [])
})
