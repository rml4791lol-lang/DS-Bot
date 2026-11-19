import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useMemo: make => make(),
  useRef: initial => ({ current: initial }),
  useLayoutEffect: () => {},
  useCallback: fn => fn,
  useContext: value => value,
  useId: () => 'test-id',
}
const require = (name) => {
  const platform = {
    react,
    'react-dom': { createPortal: node => node },
    './api.js': { call: async () => ({ schema: 1, dataMode: 'live', tasks: [], activity: [], heatmap: [] }) },
    './mark.js': { BotAvatar: () => null },
    './motion.js': { reducedMotion: () => true, SPRING_SHAPE: { duration: 420, easing: 'linear(0, 1)' } },
    './i18n.js': { t: key => key, localText: key => key, hostText: key => `host:${key}` },
    './overlay-hooks.js': { useEscape: () => {} },
  }
  if (!(name in platform)) throw new Error(`no platform module ${name}`)
  return platform[name]
}
const bundled = async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/team-activity.js', import.meta.url))],
    bundle: true, format: 'cjs', platform: 'node', write: false,
    external: ['react', 'react-dom'],
  })
  const module = { exports: {} }
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, require, setTimeout, clearTimeout, URL, URLSearchParams })
  return module.exports
}
const mod = await bundled()
const harnessRequire = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const { JSDOM } = harnessRequire('jsdom')

test('team activity type sizes and elevation use the shared UI scale', () => {
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /font-size:10px;line-height:(?:14|16)px/)
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /rgba\(/)
  assert.match(mod.TEAM_ACTIVITY_CSS, /\.bt-trace-tab\[aria-pressed=true\]\{[^}]*box-shadow:var\(--bt-card-shadow\)/)
})

test('the team activity dialog traps Tab and restores its trigger on close', () => {
  const dom = new JSDOM('<!doctype html><body><button id="trigger">Open</button><div id="layer"><button id="close">Close</button><button id="next">Next</button></div></body>')
  const { document } = dom.window
  const trigger = document.getElementById('trigger')
  const layer = document.getElementById('layer')
  trigger.focus()
  const release = mod.trapDialogFocus(layer)
  assert.equal(document.activeElement.id, 'close')

  const tab = (shiftKey = false) => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
    document.getElementById('next').dispatchEvent(event)
    return event
  }
  document.getElementById('next').focus()
  assert.equal(tab().defaultPrevented, true)
  assert.equal(document.activeElement.id, 'close')
  document.getElementById('close').focus()
  assert.equal(tab(true).defaultPrevented, true)
  assert.equal(document.activeElement.id, 'next')

  release()
  assert.equal(document.activeElement.id, 'trigger')
})

const text = node => {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return text(node.type(node.props))
  return (node.children ?? []).map(text).join('')
}
const all = (node, cls, out = []) => {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (typeof node.type === 'function') return all(node.type(node.props), cls, out)
  if ((node.props?.className ?? '').split(' ').includes(cls)) out.push(node)
  for (const child of node.children ?? []) all(child, cls, out)
  return out
}
const data = {
  schema: 1, dataMode: 'live', generatedAt: 1,
  roles: [{ id: 'chief', name: 'Chief', role: 'Coordinator', color: 'deepseek', avatar: { shape: 'whale' }, main: true, permission: 'Main Bot' }, { id: 'forge', name: 'Forge', role: 'Engineer', color: 'orange', avatar: { shape: 'fox' }, main: false, permission: 'Member' }],
  tasks: [
    { id: 'goal:g1:s1:t1', sourceId: 'goal:g1:s1:t1', source: 'goal', kind: 'goal_task', title: 'Ship MCP', subtitle: 'Ship', stageTitle: 'Bridge', parentId: 'goal:g1', ownerId: 'forge', ownerName: 'Forge', ownerRole: 'Engineer', ownerMain: false, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'working', displayState: 'working', statusSource: 'goal.task', evidenceState: 'executed', acceptance: 'tests pass', updatedAt: 10 },
    { id: 'handoff:w1', sourceId: 'handoff:w1', source: 'handoff', kind: 'handoff', title: 'Chief to Forge', parentId: null, ownerId: 'forge', ownerName: 'Forge', ownerRole: 'Engineer', ownerMain: false, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'waiting', displayState: 'waiting', statusSource: 'work.open', evidenceState: 'pending', updatedAt: 20 },
    { id: 'handoff:w2', sourceId: 'handoff:w2', source: 'handoff', kind: 'handoff', title: 'Review bridge', parentId: 'handoff:w1', ownerId: 'chief', ownerName: 'Chief', ownerRole: 'Coordinator', ownerMain: true, ownerKind: 'bot', roomName: 'Delivery', sourceStatus: 'active', displayState: 'working', statusSource: 'work.open', evidenceState: 'reported', updatedAt: 30 },
  ],
  activity: [
    { id: 'a1', source: 'board', kind: 'delivery', text: 'Delivered the bridge', botName: 'Forge', at: 10 },
  ],
  heatmap: ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16'].map(day => ({ day, count: day === '2026-11-16' ? 1 : 0 })),
  summary: { active: 1, waiting: 1, attention: 0, reported: 0, verified: 0, activity: 1 },
  filters: { sources: ['goal', 'handoff'], statuses: ['working', 'waiting', 'active'], roles: ['chief', 'forge'], attentionStatuses: ['waiting', 'pending', 'paused', 'reported', 'blocked', 'failed', 'unknown'] },
}
const roster = { byId: { chief: { id: 'chief', name: 'Chief', role: 'Coordinator' }, forge: { id: 'forge', name: 'Forge', role: 'Engineer' } }, bots: [data.roles[0], data.roles[1]], roomsById: { r1: { id: 'r1', name: 'Delivery' } }, mainBotId: 'chief' }
const detailData = {
  schema: 1, dataMode: 'live', generatedAt: 30, taskId: 'goal:g1:s1:t1', empty: false,
  task: data.tasks[0],
  owner: { id: 'forge', name: 'Forge', role: 'Engineer', kind: 'bot', main: false, missing: false },
  location: { roomId: 'r1', roomName: 'Delivery', goalId: 'g1', goalTitle: 'Ship', goalStatus: 'active', stageId: 's1', stageTitle: 'Bridge', stageIndex: 0, stageCount: 2 },
  checkpoint: { text: 'Implementation complete', at: 20, kind: 'reported' },
  nextAction: { text: 'Run the acceptance checks', sourceId: 'goal:g1:s1:t1' },
  blockers: [{ id: 'b1', kind: 'wait', text: 'Waiting for w2 to return.' }],
  evidence: [
    { id: 'e-reported', trust: 'reported', title: 'Bot report', text: 'The bridge is ready', at: 10, sourceId: 'room-s1:3', artifact: null },
    {
      id: 'e-executed', trust: 'executed', titleKey: 'trace.toolResult', toolName: 'shell', text: '1 test failed', at: 11, sourceId: 'room-s1:5', artifact: null,
      command: { text: 'npm test', exitCode: 1, outputDigest: 'sha256:feed' },
      diff: { paths: ['src/app.js'], digest: 'sha256:beef' },
    },
    { id: 'e-verified', trust: 'verified', title: 'Acceptance', text: 'All checks matched', at: 12, sourceId: 'room-s1:8', artifact: { path: 'dist/app.zip', digest: 'sha256:abc' } },
  ],
  artifacts: [{ path: 'dist/app.zip', name: 'app.zip', digest: 'sha256:abc', trust: 'verified', at: 12, sourceId: 'room-s1:8' }],
  attempt: { id: 't1:a1', number: 1, status: 'working', startedAt: 5, updatedAt: 12, sessionId: 'room-s1', exchangeId: 'review-1', turn: 7 },
  handoff: { id: 'w1', parentId: 'w0', name: 'Review the repair', status: 'active', from: { id: 'chief', name: 'Chief' }, to: { id: 'forge', name: 'Forge' }, open: 0, results: 0 },
  recovery: { state: 'recovered', records: [{ id: 't1:a1:resumed:review-1', at: 9, attemptId: 't1:a1', kind: 'resumed', summary: 'Same attempt resumed after restart.' }] },
  verification: { status: 'verified', reason: 'All declared acceptance checks matched.' },
  trace: {
    status: 'ready', sourceTaskId: 'goal:g1:s1:t1', sourceId: 'goal:g1:s1:t1', sessionIds: ['room-s1'], truncated: false,
    relationships: [{ from: 'goal:g1:s1:t1', to: 'room-s1', kind: 'task-session', labelKey: 'trace.session' }],
    timeline: [{ id: 't1', type: 'tool/result', titleKey: 'trace.toolResult', toolName: 'shell', resultKey: 'trace.failed', detail: '1 test failed', trust: 'executed', at: 11, sessionId: 'room-s1', seq: 5, relatedEvidenceId: 'e-executed', command: { text: 'npm test', exitCode: 1, outputDigest: 'sha256:feed' }, diff: { paths: ['src/app.js'], digest: 'sha256:beef' } }],
    records: [{ id: 't1', type: 'tool/result', titleKey: 'trace.toolResult', toolName: 'shell', resultKey: 'trace.failed', detail: '1 test failed', trust: 'executed', at: 11, sessionId: 'room-s1', seq: 5, relatedEvidenceId: 'e-executed', command: { text: 'npm test', exitCode: 1, outputDigest: 'sha256:feed' }, diff: { paths: ['src/app.js'], digest: 'sha256:beef' } }],
  },
  controls: [
    { id: 'pause-goal', roomId: 'r1', goalId: 'g1', enabled: true },
    { id: 'abandon-work', workId: 'w1', enabled: false, reason: 'The parent is no longer waiting.' },
  ],
  partial: false, warnings: [],
}

test('TeamActivityView renders real task rows, heatmap, and selected source detail', () => {
  const view = mod.TeamActivityView({ data, roster, status: 'ready', selectedId: 'handoff:w1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} })
  assert.ok(view.props.className.split(' ').includes('bt-team-activity'))
  assert.equal(all(view, 'bt-activity-heat-cell').length, 7)
  assert.equal(all(view, 'bt-activity-task').length, 3)
  assert.deepEqual(all(view, 'bt-activity-task-evidence').map(node => node.props['data-evidence-state']), ['executed', 'pending', 'reported', 'pending'])
  assert.match(text(view), /Team roster/)
  assert.match(text(view), /Coordinator/)
  assert.match(text(view), /Main Bot/)
  assert.match(text(view), /Engineer/)
  assert.match(text(view), /Member/)
  assert.match(text(view), /This activity view is read-only/)
  assert.match(text(view), /Review bridge/)
  assert.match(text(view), /Source ID/)
  assert.match(text(view), /handoff:w1/)
  assert.match(text(view), /Seven-day activity/)
  assert.match(text(view), /Activity records, not task completion/)
  assert.match(text(view), /Live data/)
  assert.match(text(view), /Team board · delivery · Delivered the bridge/)
})

test('TeamActivityView makes empty, filtered, partial, stale, preview, and error states explicit', () => {
  const common = { roster, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const empty = mod.TeamActivityView({ data: { ...data, tasks: [], activity: [], summary: { active: 0, waiting: 0, attention: 0, reported: 0, verified: 0, activity: 0 } }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(empty), /No team activity yet/)
  const activityOnly = mod.TeamActivityView({ data: { ...data, tasks: [] }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(activityOnly), /No current tasks/)
  const loading = mod.TeamActivityView({ data: null, status: 'loading', selectedId: null, filters: {}, ...common })
  assert.equal(all(loading, 'bt-activity-skeleton').length, 1)
  const filtered = mod.TeamActivityView({ data, status: 'ready', selectedId: null, filters: { role: 'ghost', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(filtered), /No tasks match these filters/)
  const partialData = { ...data, tasks: data.tasks.map((task, index) => index === 0 ? { ...task, warnings: ['missing owner ghost'] } : task) }
  const partial = mod.TeamActivityView({ data: partialData, status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(partial), /Partial data/)
  assert.match(text(partial), /missing owner ghost/)
  const stale = mod.TeamActivityView({ data, status: 'ready', error: 'network down', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(stale), /Could not refresh. Showing the last good result/)
  assert.match(text(stale), /network down/)
  const preview = mod.TeamActivityView({ data: { ...data, dataMode: 'preview' }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(preview), /Preview data \(not live\)/)
  assert.doesNotMatch(text(preview), /(?<!Not )Live data/)
  const demo = mod.TeamActivityView({ data: { ...data, dataMode: 'demo' }, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(demo), /Demo data/)
  const locked = mod.TeamActivityView({ data, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common, roster: { ...roster, readOnly: 'Another host owns this team' } })
  assert.match(text(locked), /Read-only host/)
  assert.match(text(locked), /Another host owns this team/)
  const error = mod.TeamActivityView({ data: null, status: 'error', error: 'Team activity could not be read', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
  assert.match(text(error), /Team activity could not be read/)
  assert.equal(error.props.role, 'dialog')
  assert.equal(all(error, 'bt-activity-skeleton').length, 0)
})

test('TeamActivityView fails closed when the data mode is missing, unknown, or inconsistent', () => {
  const common = { roster, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const missing = { ...data }
  delete missing.dataMode
  const cases = [
    missing,
    { ...data, dataMode: 'unknown' },
    { ...data, mode: 'preview' },
    { ...data, dataMode: 'preview', mode: 'live' },
  ]
  for (const value of cases) {
    const view = mod.TeamActivityView({ data: value, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, ...common })
    assert.match(text(view), /Activity data is unavailable/)
    assert.doesNotMatch(text(view), /Live data/)
    assert.doesNotMatch(text(view), /Ship MCP/)
  }
})

test('a task detail with a different data mode is not shown as live activity', () => {
  const common = { roster, status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const view = mod.TeamActivityView({ ...common, data: { ...data, dataMode: 'preview' }, detail: detailData, detailStatus: 'ready' })
  assert.match(text(view), /Preview data/)
  assert.match(text(view), /Task detail data mode does not match/)
  assert.doesNotMatch(text(view), /All checks matched/)
})

test('filterActivityModel keeps only matching source, role, status, and attention tasks', () => {
  const filtered = mod.filterActivityModel(data, { role: 'forge', source: 'goal', status: 'working', attention: false })
  assert.deepEqual(filtered.tasks.map(task => task.id), ['goal:g1:s1:t1'])
  const waiting = mod.filterActivityModel(data, { role: 'all', source: 'handoff', status: 'all', attention: true })
  assert.deepEqual(waiting.tasks.map(task => task.id), ['handoff:w1'])
  const pending = { ...data, tasks: [{ ...data.tasks[0], id: 'goal:pending', sourceStatus: 'pending', displayState: 'idle' }] }
  assert.deepEqual(mod.filterActivityModel(pending, { role: 'all', source: 'all', status: 'all', attention: true }).tasks.map(task => task.id), ['goal:pending'])
})

test('TeamActivity forwards the closing state to the rendered dialog', () => {
  const shell = mod.TeamActivity({ roster, onClose: () => {}, leaving: true, callImpl: async () => data })
  assert.equal(shell.props.className, 'bt-activity-layer')
  assert.equal(shell.props['data-leaving'], true)
  assert.equal(shell.children[0].props.className, 'bt-scrim')
  assert.equal(shell.children[1].type.name, 'TeamActivityView')
})

test('TeamActivityView renders the selected task operating detail, evidence ladder, artifacts, and trace without writes', () => {
  const view = mod.TeamActivityView({
    data, detail: detailData, detailStatus: 'ready', roster, status: 'ready', selectedId: 'goal:g1:s1:t1',
    filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {},
  })
  assert.match(text(view), /Latest checkpoint/)
  assert.match(text(view), /Implementation complete/)
  assert.match(text(view), /Next action/)
  assert.match(text(view), /Attempt/)
  assert.match(text(view), /t1:a1/)
  assert.match(text(view), /Chief.*Forge/)
  assert.match(text(view), /Recovery/)
  assert.match(text(view), /Same attempt resumed after restart/)
  assert.match(text(view), /Run the acceptance checks/)
  assert.match(text(view), /Blockers/)
  assert.match(text(view), /Waiting for w2 to return/)
  assert.match(text(view), /Reported/)
  assert.match(text(view), /Executed/)
  assert.match(text(view), /Verified/)
  assert.equal(all(view, 'bt-task-evidence').length, 3)
  assert.equal(all(view, 'bt-task-artifact').length, 1)
  assert.match(text(view), /dist\/app\.zip/)
  assert.match(text(view), /sha256:abc/)
  assert.match(text(view), /shell result/)
  assert.match(text(view), /Exit code 1/)
  assert.match(text(view), /sha256:beef/)
  assert.match(text(view), /src\/app\.js/)
  assert.match(text(view), /Trace Explorer/)
  assert.match(text(view), /Timeline/)
  assert.match(text(view), /Relationships/)
  assert.match(text(view), /Records/)
  assert.equal(all(view, 'bt-trace-tab').length, 3)
  assert.equal(all(view, 'bt-detail-control').length, 0)
  assert.doesNotMatch(text(view), /Pause goal/)
  assert.doesNotMatch(text(view), /Abandon wait/)
})

test('TraceExplorer renders timeline, relationship, and record views and drills a record to its evidence', () => {
  const copy = {
    traceExplorer: 'Trace Explorer', timeline: 'Timeline', relationships: 'Relationships', records: 'Records',
    reported: 'Reported', executed: 'Executed', verified: 'Verified', requested: 'Requested', pending: 'Pending',
    noTrace: 'No linked trace', tracePartial: 'Trace partial', traceTruncated: 'Trace truncated',
    toolCall: 'Tool call', toolResult: 'Tool result', toolResultNamed: '{name} result', artifacts: 'Artifacts presented',
    completed: 'Completed', failed: 'Failed', session: 'Session', source: 'Source', task: 'Task',
    command: 'Command', exitCode: 'Exit code', diffDigest: 'Diff digest',
  }
  const timeline = mod.TraceExplorer({ trace: detailData.trace, copy, view: 'timeline' })
  assert.match(text(timeline), /shell result/)
  assert.match(text(timeline), /Executed/)
  assert.equal(all(timeline, 'bt-trace-tab').length, 3)
  const relationships = mod.TraceExplorer({ trace: detailData.trace, copy, view: 'relationships' })
  assert.match(text(relationships), /Session/)
  assert.match(text(relationships), /goal:g1:s1:t1 → room-s1/)
  const records = mod.TraceExplorer({ trace: { ...detailData.trace, truncated: true }, copy, view: 'records' })
  assert.match(text(records), /room-s1 · #5/)
  assert.match(text(records), /shell result/)
  assert.match(text(records), /Failed/)
  assert.match(text(records), /Exit code 1/)
  assert.match(text(records), /sha256:beef/)
  assert.match(text(records), /Trace truncated/)
  let selectedEvidence = null
  const interactive = mod.TraceExplorer({ trace: detailData.trace, copy, view: 'timeline', onSelectEvidence: id => { selectedEvidence = id } })
  all(interactive, 'bt-trace-record')[0].props.onClick()
  assert.equal(selectedEvidence, 'e-executed')
})

test('task detail never dispatches state-changing actions from the read-only activity view', () => {
  const sent = []
  const actions = {
    goalControl: (...args) => sent.push(['goalControl', ...args]),
    resume: (...args) => sent.push(['resume', ...args]),
    stopMemberWork: (...args) => sent.push(['stopMemberWork', ...args]),
    stopRoomWork: (...args) => sent.push(['stopRoomWork', ...args]),
    abandonWork: (...args) => sent.push(['abandonWork', ...args]),
  }
  const common = { data, detail: detailData, detailStatus: 'ready', status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, actions, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const view = mod.TeamActivityView({ ...common, roster })
  assert.equal(all(view, 'bt-detail-control').length, 0)
  const roomView = mod.TeamActivityView({ ...common, detail: { ...detailData, controls: [{ id: 'cancel-room', roomId: 'r1', enabled: true }] } })
  assert.equal(all(roomView, 'bt-detail-control').length, 0)
  assert.deepEqual(sent, [])
})

test('task detail renders loading, stale, and removed states explicitly', () => {
  const common = { data, roster, status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const loading = mod.TeamActivityView({ ...common, detail: null, detailStatus: 'loading', detailError: '' })
  assert.match(text(loading), /Loading task detail/)
  const stale = mod.TeamActivityView({ ...common, detail: detailData, detailStatus: 'ready', detailError: 'network down' })
  assert.match(text(stale), /Could not refresh this task/)
  assert.match(text(stale), /network down/)
  const removed = mod.TeamActivityView({ ...common, detail: { ...detailData, empty: true, task: null }, detailStatus: 'ready', detailError: '' })
  assert.match(text(removed), /This task is no longer available/)
  const absent = mod.TeamActivityView({ ...common, detail: { ...detailData, checkpoint: null, nextAction: null }, detailStatus: 'ready', detailError: '' })
  assert.match(text(absent), /Latest checkpointNone/)
  assert.match(text(absent), /Next actionNone/)
})

test('requestTaskDetail reads exactly the selected task and rejects a mismatched response', async () => {
  const calls = []
  const value = await mod.requestTaskDetail(async (name, body) => {
    calls.push([name, body])
    return detailData
  }, 'goal:g1:s1:t1')
  assert.equal(value, detailData)
  assert.deepEqual(calls.map(([name, body]) => [name, body.taskId]), [['task-detail', 'goal:g1:s1:t1']])
  await assert.rejects(mod.requestTaskDetail(async () => ({ ...detailData, taskId: 'goal:other' }), 'goal:g1:s1:t1'), /did not match/)
  const missingMode = { ...detailData }
  delete missingMode.dataMode
  await assert.rejects(mod.requestTaskDetail(async () => missingMode, 'goal:g1:s1:t1'), /data mode/i)
})

test('the team activity sheet owns a unique root class', () => {
  assert.match(mod.TEAM_ACTIVITY_CSS, /\.bt-team-activity\{/)
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /\.bt-activity\{/)
})

test('the team activity surface uses the shared dialog and accessibility primitives', () => {
  const view = mod.TeamActivityView({ data, roster, status: 'ready', selectedId: 'handoff:w1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} })
  assert.deepEqual(all(view, 'bt-select').map(node => node.props.className), ['bt-select', 'bt-select', 'bt-select'])
  assert.equal(all(view, 'bt-soft-sm').length >= 2, true)
  assert.match(mod.TEAM_ACTIVITY_CSS, /@media\(prefers-reduced-motion:reduce\)/)
  assert.match(mod.TEAM_ACTIVITY_CSS, /focus-visible\{outline:2px solid var\(--bt-accent\)/)
  assert.doesNotMatch(mod.TEAM_ACTIVITY_CSS, /font-size:(?:19|18|9)px/)
})

test('unknown and group owners do not invent member permissions', () => {
  const common = { roster, status: 'ready', selectedId: null, filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {} }
  const missingTask = { ...data.tasks[0], id: 'goal:missing', ownerId: 'ghost', ownerName: '', ownerKind: 'unknown', ownerRole: '', warnings: ['missing owner ghost'] }
  const missing = mod.TeamActivityView({ data: { ...data, tasks: [missingTask], activity: [], summary: { ...data.summary, active: 0, waiting: 0, attention: 0, activity: 0 } }, ...common })
  assert.match(text(missing), /No owner/)
  assert.doesNotMatch(text(missing), /Member · Member/)
  const groupTask = { ...data.tasks[1], id: 'handoff:group', title: 'Prepare release', ownerId: null, ownerName: 'Delivery', ownerKind: 'group', ownerRole: '' }
  const group = mod.TeamActivityView({ data: { ...data, tasks: [groupTask], activity: [], summary: { ...data.summary, active: 0, waiting: 0, attention: 0, activity: 0 } }, ...common })
  assert.match(text(group), /Group chat/)
  assert.doesNotMatch(text(group), /Member · Member/)
})

test('task detail does not expose improvement proposal writes from the read-only activity view', () => {
  const calls = []
  const improvement = {
    taskId: 'goal:g1:s1:t1',
    evidenceIds: ['e-verified'],
    sourceIds: ['room-s1:8'],
    affectedBot: { id: 'forge', name: 'Forge' },
    scope: { kind: 'skill', target: 'verified-delivery-checks', label: 'Skill · verified-delivery-checks' },
    observedProblem: 'The Bot trusted a completion report without rerunning acceptance.',
    proposedChange: 'Create a learned skill that reruns the declared acceptance checks.',
    expectedBenefit: 'Release work will be checked against fresh evidence.',
    rollbackPath: 'Remove the learned skill from Forge.',
  }
  const pending = {
    id: 'improvement-1', kind: 'skill', action: 'create', botId: 'forge', name: 'verified-delivery-checks',
    description: 'Use when verifying a release.', content: 'Rerun the acceptance checks.', improvement,
  }
  const settled = { ...pending, id: 'improvement-0', outcome: 'declined', improvement: { ...improvement, taskId: 'goal:old' } }
  const actions = {
    proposeImprovement: (...args) => calls.push(['proposeImprovement', ...args]),
    learningAnswer: (...args) => calls.push(['learningAnswer', ...args]),
  }
  const common = { data, roster, status: 'ready', selectedId: 'goal:g1:s1:t1', filters: { role: 'all', source: 'all', status: 'all', attention: false }, onSelect: () => {}, onFilter: () => {}, onClose: () => {}, actions }
  const view = mod.TeamActivityView({ ...common, detail: { ...detailData, improvements: { proposals: [pending], history: [settled] } }, detailStatus: 'ready' })
  assert.doesNotMatch(text(view), /Propose improvement/)
  assert.doesNotMatch(text(view), /Observed problem/)
  assert.equal(all(view, 'bt-improvement-propose').length, 0)
  assert.equal(all(view, 'bt-learning-card').length, 0)
  assert.equal(all(view, 'bt-learning-approve').length, 0)
  assert.deepEqual(calls, [])
})
