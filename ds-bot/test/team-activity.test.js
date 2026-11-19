import assert from 'node:assert/strict'
import { test } from 'node:test'

import { activityDays, buildTeamActivity } from '../src/host/team-activity.js'
import { buildTaskDetail, taskSessionIds } from '../src/host/task-detail.js'
import { diffDigest } from '../src/host/task-evidence.js'

const NOW = Date.parse('2026-11-16T12:00:00+08:00')
const day = (offset, hour = 12) => Date.parse(`2026-11-${String(16 + offset).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`)

test('buildTaskDetail exposes the attempt, handoff route, and persisted recovery record', () => {
  const state = {
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Coordinator' },
      prism: { id: 'prism', name: 'Prism', role: 'Reviewer', sessionId: 'prism-chat' },
    },
    rooms: { r1: { id: 'r1', name: 'Delivery' } },
    works: {
      w0: { from: 'prism', to: 'chief', open: ['w1'], results: [], at: NOW - 400 },
      w1: {
        from: 'chief', to: 'prism', parent: 'w0', open: [], results: [], name: 'Review the MCP repair', at: NOW - 300,
        attempt: { id: 'w1:a1', n: 1, status: 'working', startedAt: NOW - 300, updatedAt: NOW - 100, sessionId: 'prism-chat', exchangeId: 'review-1', turn: 7 },
        checkpoint: { at: NOW - 100, attemptId: 'w1:a1', kind: 'progress', summary: 'Tests started.' },
        recovery: [{ id: 'w1:a1:resent:review-1', at: NOW - 50, attemptId: 'w1:a1', kind: 'resent', summary: 'Delivered once after the host restarted.', sessionId: 'prism-chat' }],
      },
    },
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId: 'handoff:w1', now: NOW })
  assert.deepEqual(detail.attempt, {
    id: 'w1:a1', number: 1, status: 'working', startedAt: NOW - 300, updatedAt: NOW - 100,
    sessionId: 'prism-chat', exchangeId: 'review-1', turn: 7,
  })
  assert.deepEqual(detail.handoff, {
    id: 'w1', parentId: 'w0', name: 'Review the MCP repair', status: 'active',
    from: { id: 'chief', name: 'Chief' }, to: { id: 'prism', name: 'Prism' }, open: 0, results: 0,
  })
  assert.deepEqual(detail.recovery, {
    state: 'recovered',
    records: [{ id: 'w1:a1:resent:review-1', at: NOW - 50, attemptId: 'w1:a1', kind: 'resent', summary: 'Delivered once after the host restarted.', sessionId: 'prism-chat' }],
  })
})

test('buildTaskDetail does not promote done status or prose into verified evidence', () => {
  const state = {
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Coordinator' },
      forge: { id: 'forge', name: 'Forge', role: 'Engineer' },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'Delivery',
        members: ['chief', 'forge'],
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP', updatedAt: NOW - 500,
          stages: [{
            id: 's1', title: 'Bridge', acceptance: 'tests pass', status: 'passed', evidence: 'The Bot says it passed',
            tasks: [{
              id: 't1', botId: 'forge', task: 'Build the bridge', status: 'done', note: 'Finished',
              checkpoint: { text: 'Implementation complete', at: NOW - 1_000, sourceId: 'goal:g1:s1:t1' },
              nextAction: 'Run the acceptance checks',
              evidence: [{ id: 'e1', kind: 'reported', text: 'The Bot reported completion', at: NOW - 900, sourceId: 'session:forge' }],
            }],
          }],
        },
      },
    },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
  assert.equal(detail.task.sourceStatus, 'done')
  assert.equal(detail.owner.name, 'Forge')
  assert.equal(detail.location.stageTitle, 'Bridge')
  assert.equal(detail.checkpoint.text, 'Implementation complete')
  assert.equal(detail.nextAction.text, 'Run the acceptance checks')
  assert.deepEqual(detail.evidence.map(item => [item.id, item.trust]), [
    ['goal:g1:s1:stage-evidence', 'reported'],
    ['e1', 'reported'],
  ])
  assert.deepEqual(detail.artifacts, [])
  assert.equal(detail.verification.status, 'pending')
  assert.match(detail.verification.reason, /acceptance verification/)
})

test('buildTaskDetail derives the latest goal event and a truthful next action from existing work', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery',
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP', updatedAt: NOW,
          events: [{ at: NOW - 20, kind: 'task', stage: 's1', text: 'The bridge is half built' }],
          stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', status: 'active', tasks: [{ id: 't1', botId: 'forge', task: 'Build the bridge', status: 'working' }] }],
        },
      },
    },
    works: { w1: { from: 'chief', to: 'forge', open: [], results: [], at: NOW - 10 } },
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const goal = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
  assert.equal(goal.checkpoint.text, 'The bridge is half built')
  assert.equal(goal.checkpoint.at, NOW - 20)
  assert.equal(goal.nextAction.text, 'Build the bridge')
  const handoff = buildTaskDetail({ state, activity, taskId: 'handoff:w1', now: NOW })
  assert.equal(handoff.nextAction.text, 'Wait for Forge to return.')
})

test('taskSessionIds includes the group Session fallback that DSH uses for a room', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', sessionId: 'forge-chat' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', stages: [{ id: 's1', title: 'Build', tasks: [{ id: 't1', botId: 'forge', task: 'Build it', attempt: { sessionId: 'member-room' } }] }] } } },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  assert.deepEqual(taskSessionIds({ state, activity, taskId: 'goal:g1:s1:t1' }), ['member-room', 'r1', 'forge-chat'])
})

test('buildTaskDetail joins only the selected task turns and keeps reported, requested, and executed records distinct', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery',
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP', updatedAt: NOW,
          stages: [{
            id: 's1', title: 'Bridge', acceptance: 'tests pass', status: 'active',
            tasks: [{ id: 't1', botId: 'forge', task: 'Build the bridge', status: 'working', attempt: { sessionId: 'room-s1', exchangeId: 'x1' } }],
          }],
        },
      },
    },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const records = [{
    sessionId: 'room-s1', hasMore: true,
    events: [
      { seq: 1, time: day(0, 9), type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: day(0, 9) + 1, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'Build it' }], source: { kind: 'ds-bot', role: 'request', exchangeId: 'x1', taskId: 'goal:g1:s1:t1' } } },
      { seq: 3, time: day(0, 9) + 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'The bridge is ready' }] } } },
      { seq: 4, time: day(0, 9) + 3, type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'shell', arguments: '{"command":"npm test","apiKey":"sk-secret-should-not-leak"}' } },
      { seq: 5, time: day(0, 9) + 4, type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', ok: true, content: [{ type: 'text', text: 'tests pass' }] } } },
      { seq: 6, time: day(0, 9) + 5, type: 'deliverables/presented', data: { turn: 1, files: [{ path: 'dist/app.zip', digest: 'sha256:abc' }] } },
      { seq: 7, time: day(0, 10), type: 'turn/start', data: { turn: 2 } },
      { seq: 8, time: day(0, 10) + 1, type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'Unrelated work' }] } } },
    ],
  }, {
    sessionId: 'other', events: [
      { seq: 1, time: day(0, 8), type: 'assistant/message', data: { turn: 9, message: { content: [{ type: 'text', text: 'Other session' }] } } },
    ],
  }]
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', records, now: NOW })
  assert.equal(detail.trace.sourceTaskId, 'goal:g1:s1:t1')
  assert.equal(detail.trace.sourceId, 'goal:g1:s1:t1')
  assert.deepEqual(detail.trace.sessionIds, ['room-s1'])
  assert.equal(detail.trace.truncated, true)
  assert.deepEqual(detail.trace.records.map(item => item.type), ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'deliverables/presented'])
  assert.equal(detail.trace.records.find(item => item.type === 'assistant/message').trust, 'reported')
  assert.equal(detail.trace.records.find(item => item.type === 'tool/call').trust, 'requested')
  assert.equal(detail.trace.records.find(item => item.type === 'tool/result').trust, 'executed')
  assert.equal(detail.trace.records.find(item => item.type === 'deliverables/presented').trust, 'executed')
  assert.ok(detail.trace.relationships.some(item => item.kind === 'task-session' && item.to === 'room-s1'))
  assert.deepEqual(detail.artifacts.map(item => [item.path, item.digest, item.trust]), [['dist/app.zip', 'sha256:abc', 'executed']])
  assert.equal(detail.evidence.find(item => item.id === 'trace:room-s1:3:reported').trust, 'reported')
  assert.equal(detail.evidence.find(item => item.id === 'trace:room-s1:5:executed').trust, 'executed')
  assert.doesNotMatch(JSON.stringify(detail), /Unrelated work|Other session|sk-secret-should-not-leak/)
})

test('buildTaskDetail preserves command exits and stable diff digests from tool results', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery',
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP', updatedAt: NOW,
          stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', status: 'active', tasks: [{ id: 't1', botId: 'forge', task: 'Build the bridge', status: 'working', attempt: { sessionId: 'room-s1', exchangeId: 'x1' } }] }],
        },
      },
    },
    works: {},
  }
  const diffs = [{ path: 'src/app.js', oldText: 'old', newText: 'new' }]
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const records = [{
    sessionId: 'room-s1', events: [
      { seq: 1, time: day(0, 9), type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'Build it' }], source: { exchangeId: 'x1' } } },
      { seq: 2, time: day(0, 9) + 1, type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'shell', arguments: '{"command":"npm test"}' } },
      { seq: 3, time: day(0, 9) + 2, type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', ok: false, exitCode: 7, content: [{ type: 'text', text: '1 test failed' }], meta: { diffs } } } },
    ],
  }]
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', records, now: NOW })
  const record = detail.trace.records.find(item => item.type === 'tool/result')
  const evidence = detail.evidence.find(item => item.id === 'trace:room-s1:3:executed')
  const expectedDigest = diffDigest(diffs)
  assert.deepEqual(record.command, { text: 'npm test', exitCode: 7, outputDigest: record.command.outputDigest })
  assert.match(record.command.outputDigest, /^sha256:[a-f0-9]{64}$/)
  assert.deepEqual(record.diff, { paths: ['src/app.js'], digest: expectedDigest })
  assert.deepEqual(evidence.command, record.command)
  assert.deepEqual(evidence.diff, record.diff)
})

test('buildTaskDetail redacts secret-looking state prose in every detail section', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery',
        goal: {
          id: 'g1', status: 'active', title: 'Ship',
          stages: [{
            id: 's1', title: 'Build', acceptance: 'tests pass', evidence: 'token=stage-secret-value',
            tasks: [{
              id: 't1', botId: 'forge', task: 'Build it', status: 'blocked',
              checkpoint: { text: 'token=checkpoint-secret-value', at: NOW - 10 },
              nextAction: 'api_key=next-secret-value',
              blockers: ['sk-blockersecretvalue'],
              evidence: ['password=evidence-secret-value'],
            }],
          }],
        },
      },
    },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const output = JSON.stringify(buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW }))
  assert.doesNotMatch(output, /stage-secret-value|checkpoint-secret-value|next-secret-value|blockersecretvalue|evidence-secret-value/)
})

test('buildTaskDetail joins a goal attempt by its exchange id when the event has no task id', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery',
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP',
          stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', tasks: [{ id: 't1', botId: 'forge', task: 'Build it', status: 'working', attempt: { sessionId: 'room-s1', exchangeId: 'attempt-1' } }] }],
        },
      },
    },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const records = [{ sessionId: 'room-s1', events: [
    { seq: 1, time: day(0, 9), type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: day(0, 9) + 1, type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'Work on the attempt' }], source: { kind: 'ds-bot', role: 'request', exchangeId: 'attempt-1' } } },
    { seq: 3, time: day(0, 9) + 2, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Attempt reported' }] } } },
  ] }]
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', records, now: NOW })
  assert.equal(detail.trace.status, 'ready')
  assert.deepEqual(detail.trace.records.map(item => item.type), ['user/message', 'assistant/message'])
})

test('buildTaskDetail accepts verified only through a fresh explicit verification binding', () => {
  const task = {
    id: 't1', botId: 'forge', task: 'Build the bridge', status: 'done', updatedAt: NOW,
    evidence: [{
      id: 'verify-1', kind: 'verified', text: 'All declared checks matched', at: NOW - 100,
      sourceId: 'session:forge:12', artifact: { path: 'dist/app.zip', digest: 'sha256:abc' },
    }],
  }
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', status: 'active', title: 'Ship MCP', stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', tasks: [task] }] } } },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const unbound = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
  assert.equal(unbound.verification.status, 'pending')
  task.verification = {
    status: 'verified', evidenceIds: ['verify-1'], verifiedAt: NOW - 50,
    checks: [{ text: 'tests pass', status: 'verified', evidenceId: 'verify-1' }],
  }
  const verified = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
  assert.equal(verified.verification.status, 'verified')
  assert.deepEqual(verified.artifacts.map(item => [item.path, item.digest, item.trust]), [['dist/app.zip', 'sha256:abc', 'verified']])
})

test('Team Activity and Task Detail share one verification projection', () => {
  const cases = [
    { name: 'executed', task: { status: 'working', evidence: [{ id: 'e1', kind: 'executed', text: 'Tests ran', at: NOW - 100 }] }, state: 'executed', status: 'pending' },
    { name: 'reported', task: { status: 'reported', evidence: [{ id: 'e1', kind: 'reported', text: 'Ready', at: NOW - 100 }] }, state: 'reported', status: 'pending' },
    { name: 'verified', task: { status: 'done', evidence: [{ id: 'e1', kind: 'verified', text: 'Checks passed', at: NOW - 100 }], verification: { status: 'verified', evidenceIds: ['e1'], verifiedAt: NOW - 50, checks: [{ status: 'verified', evidenceId: 'e1' }] } }, state: 'verified', status: 'verified' },
    { name: 'stale', task: { status: 'done', evidence: [{ id: 'e1', kind: 'verified', text: 'Old checks', at: NOW - 100 }], verification: { status: 'stale', reason: 'The artifact changed.', evidenceIds: ['e1'], verifiedAt: NOW - 50 } }, state: 'stale', status: 'stale' },
    { name: 'needs-review', task: { status: 'reported', evidence: [{ id: 'e1', kind: 'reported', text: 'Review this', at: NOW - 100 }], verification: { status: 'needs-review', reason: 'A reviewer must decide.' } }, state: 'needs-review', status: 'needs-review' },
  ]
  for (const item of cases) {
    const state = {
      bots: { forge: { id: 'forge', name: 'Forge' } },
      rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', status: 'active', title: 'Ship', stages: [{ id: 's1', title: 'Build', acceptance: 'tests pass', tasks: [{ id: 't1', botId: 'forge', task: 'Build it', ...item.task }] }] } } },
      works: {},
    }
    const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
    const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
    assert.equal(activity.tasks[0].evidenceState, item.state, item.name)
    assert.equal(detail.evidenceState, item.state, item.name)
    assert.equal(activity.tasks[0].verification.status, item.status, item.name)
    assert.deepEqual(activity.tasks[0].verification, detail.verification, item.name)
  }
})

test('trace labels are semantic keys rather than host-built English strings', () => {
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge', role: 'Engineer' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', status: 'active', title: 'Ship', stages: [{ id: 's1', title: 'Build', tasks: [{ id: 't1', botId: 'forge', task: 'Build it', status: 'working', attempt: { sessionId: 'room-s1' } }] }] } } },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const records = [{
    sessionId: 'room-s1', events: [
      { seq: 1, time: day(0, 9), type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'Build it' }], source: { taskId: 'goal:g1:s1:t1' } } },
      { seq: 2, time: day(0, 9) + 1, type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Ready' }] } } },
      { seq: 3, time: day(0, 9) + 2, type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'shell', arguments: '{"command":"npm test"}' } },
      { seq: 4, time: day(0, 9) + 3, type: 'tool/result', data: { turn: 1, message: { toolCallId: 'c1', ok: true, exitCode: 0, content: [{ type: 'text', text: 'pass' }] } } },
      { seq: 5, time: day(0, 9) + 4, type: 'deliverables/presented', data: { turn: 1, files: [{ path: 'dist/app.zip', digest: 'sha256:abc' }] } },
    ],
  }]
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', records, now: NOW })
  assert.deepEqual(detail.trace.records.map(item => item.titleKey), [
    'trace.request', 'trace.report', 'trace.toolCall', 'trace.toolResult', 'trace.artifacts',
  ])
  assert.equal(detail.trace.records.find(item => item.type === 'tool/result').resultKey, 'trace.completed')
  assert.deepEqual(detail.trace.relationships.map(item => item.labelKey), [
    'trace.source', 'trace.session', 'trace.task',
  ])
  assert.doesNotMatch(JSON.stringify(detail.trace), /"(?:title|label)":|"resultKey":"(?:completed|failed)"/)
})

test('buildTaskDetail keeps stale acceptance stale instead of reviving old verified evidence', () => {
  const task = {
    id: 't1', botId: 'forge', task: 'Build the bridge', status: 'done',
    evidence: [{ id: 'verify-1', kind: 'verified', text: 'Old acceptance', at: NOW - 100, artifact: { path: 'dist/app.zip', digest: 'sha256:old' } }],
    verification: { status: 'stale', reason: 'dist/app.zip changed after acceptance', evidenceIds: ['verify-1'], verifiedAt: NOW - 50 },
  }
  const state = {
    bots: { forge: { id: 'forge', name: 'Forge' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', status: 'active', title: 'Ship', stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', tasks: [task] }] } } },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', now: NOW })
  assert.equal(detail.verification.status, 'stale')
  assert.match(detail.verification.reason, /changed after acceptance/)
  assert.equal(detail.evidence.find(item => item.id === 'verify-1').trust, 'reported')
})

test('buildTaskDetail exposes existing goal controls and disables every control on a read-only host', () => {
  const state = {
    bots: {
      forge: { id: 'forge', name: 'Forge', role: 'Engineer', blocked: { code: 'AUTH', at: NOW - 10 } },
    },
    rooms: {
      r1: {
        id: 'r1', name: 'Delivery', sessions: { forge: 'room-s1' },
        goal: {
          id: 'g1', status: 'active', title: 'Ship MCP', current: 0,
          stages: [{ id: 's1', title: 'Bridge', acceptance: 'tests pass', status: 'active', tasks: [{ id: 't1', botId: 'forge', task: 'Build the bridge', status: 'working' }] }],
        },
      },
    },
    works: {},
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', liveSessionIds: ['room-s1'], now: NOW })
  assert.deepEqual(detail.controls.map(item => [item.id, item.enabled]), [
    ['pause-goal', true],
    ['stop-goal', true],
    ['retry-bot', true],
    ['cancel-work', true],
  ])
  const locked = buildTaskDetail({ state, activity, taskId: 'goal:g1:s1:t1', liveSessionIds: ['room-s1'], now: NOW, readOnly: 'Another host owns this team' })
  assert.equal(locked.controls.length, 4)
  assert.ok(locked.controls.every(item => item.enabled === false && item.reason === 'Another host owns this team'))
})

test('buildTaskDetail represents empty, partial, preview, unknown, and recovery states without fake success', () => {
  const state = {
    bots: { chief: { id: 'chief', name: 'Chief', role: 'Coordinator' } },
    rooms: { r1: { id: 'r1', name: 'Delivery' } },
    works: {
      w0: { from: 'chief', to: 'chief', open: ['w1'], results: [] },
      w1: { from: 'chief', to: 'ghost', parent: 'w0', open: ['w2'], name: 'Review bridge', late: true, results: [{ id: 'r1', name: 'Reader', text: 'broken', failed: true }], at: NOW - 300 },
      w2: { from: 'ghost', to: 'chief', parent: 'w1', open: [], results: [], at: NOW - 200 },
    },
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const empty = buildTaskDetail({ state, activity, taskId: 'handoff:missing', now: NOW })
  assert.equal(empty.empty, true)
  assert.equal(empty.task, null)
  assert.equal(empty.trace.status, 'empty')

  const work = buildTaskDetail({ state, activity, taskId: 'handoff:w1', sourceWarnings: ['One Session could not be read'], now: NOW })
  assert.equal(work.owner.missing, true)
  assert.equal(work.partial, true)
  assert.equal(work.trace.status, 'partial')
  assert.deepEqual(work.blockers.map(item => item.kind), ['owner', 'wait', 'failed-result', 'recovery'])
  assert.match(work.blockers.map(item => item.text).join(' '), /missing owner ghost/i)
  assert.match(work.blockers.map(item => item.text).join(' '), /waiting for w2/i)
  assert.match(work.blockers.map(item => item.text).join(' '), /Reader failed/i)
  assert.match(work.blockers.map(item => item.text).join(' '), /after a restart/i)

  const preview = buildTaskDetail({ state, activity: { ...activity, dataMode: 'preview' }, taskId: 'handoff:w1', now: NOW })
  assert.equal(preview.dataMode, 'preview')
  assert.equal(preview.verification.status, 'unavailable')
  assert.match(preview.verification.reason, /preview data/i)
  assert.ok(preview.controls.every(item => item.enabled === false))

  const missingMode = { ...activity }
  delete missingMode.dataMode
  for (const invalid of [missingMode, { ...activity, dataMode: 'unknown' }, { ...activity, mode: 'preview' }, { ...activity, dataMode: 'preview', mode: 'live' }]) {
    const detail = buildTaskDetail({ state, activity: invalid, taskId: 'handoff:w1', now: NOW })
    assert.equal(detail.dataMode, 'unknown')
    assert.equal(detail.verification.status, 'unavailable')
    assert.ok(detail.controls.every(item => item.enabled === false))
  }
})

test('buildTaskDetail offers handoff abandon only for a child that its parent still waits on', () => {
  const state = {
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Coordinator' },
      forge: { id: 'forge', name: 'Forge', role: 'Engineer' },
    },
    rooms: { r1: { id: 'r1', name: 'Delivery' } },
    works: {
      w0: { from: 'chief', to: 'chief', open: ['w1'], results: [] },
      w1: { from: 'chief', to: 'forge', parent: 'w0', open: [], results: [], at: NOW - 200 },
      w2: { from: 'chief', to: 'forge', open: [], results: [], at: NOW - 100 },
    },
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const child = buildTaskDetail({ state, activity, taskId: 'handoff:w1', now: NOW })
  assert.deepEqual(child.controls.filter(item => item.id === 'abandon-work').map(item => [item.id, item.workId, item.enabled]), [['abandon-work', 'w1', true]])
  const root = buildTaskDetail({ state, activity, taskId: 'handoff:w2', now: NOW })
  assert.equal(root.controls.some(item => item.id === 'abandon-work'), false)
})

test('buildTaskDetail offers the existing room stop for a group-owned handoff', () => {
  const state = {
    bots: { chief: { id: 'chief', name: 'Chief' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', sessionId: 'group-session' } },
    works: { w1: { from: 'chief', room: 'r1', open: [], results: [], at: NOW - 100 } },
  }
  const activity = buildTeamActivity({ state, now: NOW, timeZone: 'Asia/Shanghai' })
  const detail = buildTaskDetail({ state, activity, taskId: 'handoff:w1', liveSessionIds: ['group-session'], now: NOW })
  assert.deepEqual(detail.controls.map(item => [item.id, item.roomId, item.enabled]), [['cancel-room', 'r1', true]])
})

test('buildTeamActivity projects goal tasks and open handoffs as real source rows', () => {
  const state = {
    mainBotIds: ['chief'],
    bots: {
      chief: { id: 'chief', name: 'Chief', role: 'Coordinator', color: 'deepseek', avatar: { shape: 'whale' }, sectionId: 'core' },
      forge: { id: 'forge', name: 'Forge', role: 'Engineer', sectionId: 'engineering' },
    },
    rooms: {
      r1: {
        id: 'r1',
        name: 'Delivery',
        admin: 'chief',
        members: ['chief', 'forge'],
        goal: {
          id: 'g1',
          revision: 4,
          status: 'active',
          title: 'Ship MCP',
          updatedAt: NOW - 1_000,
          stages: [{
            id: 's1',
            title: 'Build the bridge',
            acceptance: 'tests pass',
            status: 'active',
            tasks: [{ id: 't1', botId: 'forge', task: 'Implement the bridge', status: 'working' }],
          }],
        },
      },
    },
    works: {
      w1: {
        from: 'chief', to: 'forge', at: NOW - 2_000, open: [], results: [],
        attempt: { updatedAt: NOW - 300 },
        checkpoint: { at: NOW - 200 },
        evidence: [{ at: NOW - 100 }],
      },
      w2: { from: 'chief', room: 'r1', at: NOW - 3_000, open: [], results: [] },
    },
  }

  const value = buildTeamActivity({ state, board: [], ledger: [], now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.schema, 1)
  assert.deepEqual(value.roles.map(role => [role.id, role.main, role.permission]), [['chief', true, 'Main Bot'], ['forge', false, 'Member']])
  assert.deepEqual(value.roles[0].avatar, { shape: 'whale' })
  assert.equal(value.roles[0].color, 'deepseek')
  assert.deepEqual(value.filters.attentionStatuses, ['waiting', 'pending', 'paused', 'reported', 'blocked', 'failed', 'unknown'])
  assert.deepEqual(value.tasks.map(task => [task.source, task.sourceId, task.sourceStatus]).sort(), [
    ['goal', 'goal:g1:s1:t1', 'working'],
    ['handoff', 'handoff:w1', 'active'],
    ['handoff', 'handoff:w2', 'active'],
  ])
  const goal = value.tasks.find(task => task.source === 'goal')
  assert.equal(goal.ownerId, 'forge')
  assert.equal(goal.ownerName, 'Forge')
  assert.equal(goal.roomName, 'Delivery')
  assert.equal(goal.stageTitle, 'Build the bridge')
  assert.equal(goal.acceptance, 'tests pass')
  const work = value.tasks.find(task => task.id === 'handoff:w1')
  assert.equal(work.ownerId, 'forge')
  assert.equal(work.ownerMain, false)
  assert.equal(work.parentId, null)
  assert.equal(work.statusSource, 'work.open')
  assert.equal(work.displayState, 'working')
  assert.equal(work.updatedAt, NOW - 100)
  assert.match(work.title, /Forge/)
  const groupWork = value.tasks.find(task => task.id === 'handoff:w2')
  assert.equal(groupWork.ownerId, null)
  assert.equal(groupWork.ownerName, 'Delivery')
  assert.equal(groupWork.ownerKind, 'group')
  assert.equal(groupWork.roomName, 'Delivery')
})

test('buildTeamActivity creates deterministic seven-day buckets from real activity times', () => {
  const state = {
    mainBotIds: [],
    bots: { ops: { id: 'ops', name: 'Ops', role: 'Operator' } },
    rooms: {},
    works: {},
  }
  const board = [
    { bot: 'Ops', kind: 'delivery', what: 'today', at: '2026-11-16T09:00:00+08:00' },
    { bot: 'Ops', kind: 'decision', what: 'yesterday', at: '2026-11-15T09:00:00+08:00' },
    { bot: 'Ops', kind: 'blocked', what: 'too old', at: '2026-11-08T09:00:00+08:00' },
  ]
  const ledger = [
    { id: 'w1', kind: 'open', time: day(-2), from: 'ops', to: 'ops' },
    { id: 'w1', kind: 'close', time: day(-2, 13), outcome: 'answered' },
  ]

  const value = buildTeamActivity({ state, board, ledger, now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.heatmap.length, 7)
  assert.deepEqual(value.heatmap.map(item => item.day), [
    '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16',
  ])
  assert.equal(value.heatmap.find(item => item.day === '2026-11-16').count, 1)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-15').count, 1)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-14').count, 2)
  assert.equal(value.heatmap.find(item => item.day === '2026-11-10').count, 0)
  assert.equal(value.activity[0].text, 'today')
  assert.equal(value.activity[0].source, 'board')
  assert.ok(value.activity.some(item => item.source === 'ledger' && item.text.includes('w1')))
  assert.ok(!value.activity.some(item => item.text === 'too old'))
})

test('buildTeamActivity keeps partial legacy data visible without inventing completion', () => {
  const state = {
    bots: { forge: { name: 'Forge', role: 'Engineer' } },
    rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', stages: [{ id: 's1', title: 'Build', tasks: [{ id: 't1', botId: 'ghost', task: 'Recover', status: 'blocked' }] }] } } },
    works: { orphan: { from: 'missing', at: NOW - 500, open: ['child'], results: [] } },
  }
  const value = buildTeamActivity({ state, board: [], ledger: [], now: NOW, timeZone: 'Asia/Shanghai' })
  assert.equal(value.tasks.length, 2)
  const handoff = value.tasks.find(task => task.source === 'handoff')
  const goal = value.tasks.find(task => task.source === 'goal')
  assert.equal(handoff.sourceStatus, 'waiting')
  assert.equal(handoff.ownerId, null)
  assert.equal(handoff.ownerName, '')
  assert.equal(handoff.ownerKind, 'unknown')
  assert.equal(handoff.title, 'missing')
  assert.equal(goal.ownerName, '')
  assert.equal(goal.ownerKind, 'unknown')
  assert.equal(value.partial, true)
  assert.deepEqual(value.warnings.map(item => item.taskId), ['handoff:orphan', 'goal:g1:s1:t1'])
  assert.equal(value.summary.reported, 0)
  assert.equal(value.summary.verified, 0)
})

test('buildTeamActivity carries source-read warnings into the partial state', () => {
  const value = buildTeamActivity({
    state: { bots: {}, rooms: {}, works: {} },
    sourceWarnings: ['team board archive: skipped 1 bad row in ops.jsonl'],
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.partial, true)
  assert.deepEqual(value.warnings, [{ taskId: null, message: 'team board archive: skipped 1 bad row in ops.jsonl' }])
})

test('buildTeamActivity does not count a done goal task as verified', () => {
  const value = buildTeamActivity({
    state: {
      bots: { forge: { id: 'forge', name: 'Forge' } },
      rooms: { r1: { id: 'r1', name: 'Delivery', goal: { id: 'g1', status: 'active', title: 'Ship', stages: [{ id: 's1', title: 'Build', acceptance: 'tests pass', status: 'passed', evidence: 'The Bot says so', tasks: [{ id: 't1', botId: 'forge', task: 'Build it', status: 'done' }] }] } } },
      works: {},
    },
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.summary.verified, 0)
  assert.equal(value.tasks[0].sourceStatus, 'done')
  assert.equal(value.tasks[0].evidenceState, 'reported')
})

test('buildTeamActivity keeps stale or incompletely checked acceptance out of verified', () => {
  const value = buildTeamActivity({
    state: {
      bots: { forge: { id: 'forge', name: 'Forge' } },
      rooms: {
        r1: {
          id: 'r1', name: 'Delivery',
          goal: {
            id: 'g1', status: 'active', title: 'Ship',
            stages: [{
              id: 's1', title: 'Build', acceptance: 'tests pass', status: 'passed',
              tasks: [{
                id: 't1', botId: 'forge', task: 'Build it', status: 'done',
                evidence: [{ id: 'e1', kind: 'verified', text: 'Old result', stale: true }],
                verification: { status: 'verified', evidenceIds: ['e1'], checks: [{ status: 'pending' }] },
              }],
            }],
          },
        },
      },
      works: {},
    },
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.tasks[0].evidenceState, 'reported')
  assert.equal(value.summary.verified, 0)
})

test('activityDays keeps seven unique calendar days across DST', () => {
  const spring = activityDays(Date.parse('2026-03-10T04:30:00Z'), 'America/New_York')
  assert.deepEqual(spring, ['2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10'])
  const fall = activityDays(Date.parse('2026-11-02T12:00:00Z'), 'America/New_York')
  assert.deepEqual(fall, ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
})

test('buildTeamActivity marks board rows without a real time as partial', () => {
  const value = buildTeamActivity({
    state: { bots: {}, rooms: {}, works: {} },
    board: [{ bot: 'Ops', kind: 'delivery', what: 'unknown time' }],
    now: NOW,
    timeZone: 'Asia/Shanghai',
  })
  assert.equal(value.partial, true)
  assert.match(value.warnings[0].message, /without a valid time/)
})
