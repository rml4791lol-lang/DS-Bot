import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { INBOX_READ_MAX, install, parseInbox } from '../src/host/inbox.js'
import { install as installLedger } from '../src/host/ledger.js'
import { fakeContext } from './fake-ctx.js'

const host = (t, { readOnly, home: given } = {}) => {
  const home = given ?? mkdtempSync(join(tmpdir(), 'ds-bot-inbox-'))
  const warnings = []
  const rt = { home, readOnly: () => readOnly, warn: (...args) => warnings.push(args) }
  installLedger(rt)
  install(rt)
  // The ledger writes behind the call that appended; removing the folder first let a
  // late write land in it and rmdir fail with ENOTEMPTY on a busy runner.
  if (given === undefined) t.after(async () => {
    await rt.ledger.flush()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  return {
    rt,
    home,
    warnings,
    file: botId => join(home, 'inbox', `${botId}.jsonl`),
    cursor: botId => join(home, 'inbox', `${botId}.cursor.json`),
  }
}

const entry = (over = {}) => ({ from: 'b', fromName: 'Writer', role: 'update', sessionId: 's-a', exchangeId: 'x-1', text: 'note', time: 1763000000000, ...over })

test('append keeps the schema, oldest first, and a resend writes no second line', async (t) => {
  const { rt, file } = host(t)
  const first = await rt.inbox.append('a', entry({ senderRoomId: 'r9', roomId: 'r9' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'second', time: 1763000001000 }))
  // The same exchange arriving twice is one note: it reaches the Bot once.
  const again = await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'resent', time: 1763000002000 }))
  assert.equal(again.id, first.id)
  assert.equal(again.text, 'note')
  assert.equal(first.id.length > 0, true)
  const entries = rt.inbox.list('a')
  assert.deepEqual(entries.map(item => item.text), ['note', 'second'])
  assert.equal(rt.inbox.unreadCount('a'), 2)
  const lines = readFileSync(file('a'), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const record = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(record), ['id', 'from', 'fromName', 'role', 'sessionId', 'senderRoomId', 'exchangeId', 'roomId', 'text', 'time'])
  assert.deepEqual([record.sessionId, record.senderRoomId, record.exchangeId], ['s-a', 'r9', 'x-1'])
  assert.equal(record.time, 1763000000000)
})

test('markRead moves a cursor file and never rewrites the message lines', async (t) => {
  const { rt, home, file, cursor } = host(t)
  const one = await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'one' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'two' }))
  await rt.inbox.append('a', entry({ exchangeId: 'x-3', text: 'three' }))
  const before = readFileSync(file('a'), 'utf8')
  assert.equal(await rt.inbox.markRead('a', [one.id]), 1)
  assert.equal(readFileSync(file('a'), 'utf8'), before)
  assert.equal(JSON.parse(readFileSync(cursor('a'), 'utf8')).cursor, 1)
  assert.deepEqual(rt.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['two', 'three'])
  assert.deepEqual(rt.inbox.list('a').map(item => [item.text, item.unread]), [['one', false], ['two', true], ['three', true]])
  assert.equal(rt.inbox.unreadCount('a'), 2)
  // A cursor only moves forward: an earlier id cannot unread a later note.
  assert.equal(await rt.inbox.markRead('a', [one.id]), 0)
  // The cursor is what survives a restart; the messages are replayed from the file.
  const replayed = { home, readOnly: () => undefined, warn: () => {} }
  install(replayed)
  assert.equal(replayed.inbox.unreadCount('a'), 2)
  assert.deepEqual(replayed.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['two', 'three'])
})

test('a window reads oldest first, so the next read starts where the last one stopped', async (t) => {
  const { rt } = host(t)
  for (let at = 1; at <= 25; at += 1) await rt.inbox.append('a', entry({ exchangeId: `x-${at}`, text: `m${at}` }))
  const first = rt.inbox.list('a', { limit: 3 })
  assert.deepEqual(first.map(item => item.text), ['m1', 'm2', 'm3'])
  assert.equal(await rt.inbox.markRead('a', first.map(item => item.id)), 3)
  assert.deepEqual(rt.inbox.list('a', { unreadOnly: true }).map(item => item.text), ['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13'])
  assert.equal(rt.inbox.list('a', { limit: 999 }).length, INBOX_READ_MAX)
  assert.equal(rt.inbox.list('a', { limit: 0 }).length, 1)
})

test('a line cut by an interruption is skipped, and the next record gets its own line', async (t) => {
  const { rt, home, file } = host(t)
  await rt.inbox.append('a', entry({ exchangeId: 'x-1', text: 'whole' }))
  const whole = readFileSync(file('a'), 'utf8')
  writeFileSync(file('a'), `${whole}{"id":"cut","text":"no end`)
  assert.deepEqual(rt.inbox.list('a').map(item => item.text), ['whole'])
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'again' }))
  assert.deepEqual(rt.inbox.list('a').map(item => item.text), ['whole', 'again'])
  assert.equal(parseInbox(readFileSync(join(home, 'inbox', 'a.jsonl'), 'utf8')).length, 2)
})

test('a mailbox is per Bot, and a read-only host writes nothing', async (t) => {
  const { rt, file } = host(t)
  await rt.inbox.append('a', entry({ text: 'for a' }))
  assert.deepEqual(rt.inbox.list('b'), [])
  assert.equal(existsSync(file('b')), false)
  const reader = host(t, { readOnly: 'another dsh holds the team' })
  await assert.rejects(reader.rt.inbox.append('a', entry({ text: 'nope' })), /cannot be written/)
  assert.equal(await reader.rt.inbox.markRead('a', ['x']), 0)
  assert.equal(reader.rt.inbox.list('a').length, 0)
})

test('a note that cannot be written leaves a ledger mark and a mailbox gap', async (t) => {
  const { rt, home, file } = host(t)
  // A directory where the mailbox file goes: every append fails.
  mkdirSync(join(home, 'inbox'), { recursive: true })
  mkdirSync(file('a'))
  const before = Date.now()
  await assert.rejects(rt.inbox.append('a', entry({ exchangeId: 'x-lost', text: 'lost' })))
  const marks = rt.ledger.records('inbox-a')
  assert.equal(marks.length, 1)
  assert.equal(marks[0].event, 'failed')
  assert.equal(marks[0].id, 'x-lost')
  // The hole is timed by when the note was lost, not by when the message was written.
  assert.ok(marks[0].time >= before, 'the mark is timed when the write failed')
  assert.match(marks[0].reason, /EISDIR|directory/)
  assert.deepEqual(rt.inbox.gaps('a'), [{ from: marks[0].time, to: null, reason: marks[0].reason, count: 1 }])
  // The mailbox takes a note again: the stretch ends there.
  rmSync(file('a'), { recursive: true, force: true })
  await rt.inbox.append('a', entry({ exchangeId: 'x-2', text: 'again' }))
  const [gap] = rt.inbox.gaps('a')
  assert.equal(gap.from, marks[0].time)
  assert.equal(typeof gap.to, 'number')
  assert.equal(gap.count, 1)
  // Only the note that landed is in the mailbox; the lost one is what the gap names.
  assert.deepEqual(rt.inbox.list('a').map(item => item.text), ['again'])
})

test('gaps stay empty while every note lands', async (t) => {
  const { rt } = host(t)
  await rt.inbox.append('a', entry())
  assert.deepEqual(rt.inbox.gaps('a'), [])
  assert.deepEqual(rt.ledger.records('inbox-a'), [])
})

test('a gap is read back from the ledger, so it survives a restart', async (t) => {
  const { rt, home, file } = host(t)
  mkdirSync(join(home, 'inbox'), { recursive: true })
  mkdirSync(file('a'))
  await assert.rejects(rt.inbox.append('a', entry({ exchangeId: 'x-lost' })))
  const marks = rt.ledger.records('inbox-a')
  await rt.ledger.flush()
  const replayed = { home, readOnly: () => undefined, warn: () => {} }
  installLedger(replayed)
  install(replayed)
  const [gap] = replayed.inbox.gaps('a')
  assert.equal(gap.from, marks[0].time)
  assert.equal(gap.to, null)
  assert.equal(gap.count, 1)
})

test('a gap counts the exchanges it lost, not the attempts to write them', async (t) => {
  const { rt, home, file } = host(t)
  mkdirSync(join(home, 'inbox'), { recursive: true })
  mkdirSync(file('a'))
  // The same note is sent again while the mailbox is broken: it is one lost exchange.
  for (let at = 0; at < 2; at += 1) await assert.rejects(rt.inbox.append('a', entry({ exchangeId: 'x-lost', text: 'lost' })))
  assert.equal(rt.ledger.records('inbox-a').length, 2)
  assert.deepEqual(rt.inbox.gaps('a').map(gap => gap.count), [1])
})

test('read_inbox shows a quiet note, marks it read, and works in a group Session', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-read-inbox-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['a'],
    bots: {
      a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
      b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    },
    rooms: { r1: { id: 'r1', name: 'Ops', members: ['a', 'b'], sessions: { b: 'g1' }, log: [], seq: 0 } },
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    revision: 0,
  }))
  const ctx = fakeContext()
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  })
  await rt.load()
  await rt.inbox.append('b', entry({ exchangeId: 'x-1', text: 'Your profile was updated. Ship it.' }))
  const read = rt.teamTools.find(def => def.name === 'read_inbox')
  assert.ok(read, 'read_inbox is a team tool')
  const seen = await read.execute({}, { agent: { id: 'b' } })
  assert.deepEqual(seen.gaps, [], 'nothing is missing when every note landed')
  assert.match(seen.text, /^1 note for Writer:/)
  assert.match(seen.text, /Writer · profile update/)
  assert.match(seen.text, /Your profile was updated/)
  assert.match(seen.text, /never start a turn/)
  assert.equal(rt.inbox.unreadCount('b'), 0)
  assert.match((await read.execute({}, { agent: { id: 'b' } })).text, /^No unread notes/)
  // A group Session belongs to its Bot: the relay scope includes the inbox.
  await rt.inbox.append('b', entry({ exchangeId: 'x-2', text: 'Stop receipt' }))
  const group = await read.execute({}, { agent: { id: 'g1' } })
  assert.match(group.text, /^1 note for Writer:/)
  assert.match(group.text, /stop receipt|update/)
  // A note the mailbox cannot take: the reading Bot is told a stretch is missing.
  rmSync(join(home, 'inbox', 'b.jsonl'))
  mkdirSync(join(home, 'inbox', 'b.jsonl'))
  await assert.rejects(rt.inbox.append('b', entry({ exchangeId: 'x-lost', text: 'lost note' })))
  const gaps = await read.execute({}, { agent: { id: 'b' } })
  assert.equal(gaps.gaps.length, 1)
  assert.equal(gaps.gaps[0].to, null)
  // The prose is rendered from the structured gaps, so the two cannot drift apart.
  assert.doesNotMatch(gaps.text, /could not be saved/)
  const [shown] = read.output.render({}, gaps)
  assert.match(shown.text, /1 note could not be saved/)
  assert.match(shown.text, /Ask the sender to resend anything that still matters\./)
  assert.equal(rt.ledger.records('inbox-b').filter(record => record.event === 'failed').length, 1)
})
