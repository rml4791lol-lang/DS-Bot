// The team board: one right-hand column answering "who is doing what, right now".
// It draws no data of its own — the mount gives it the roster and work snapshots that
// already arrive through the live feed, so the board moves when they do. The only
// timer here is a one-second display clock that refreshes the "已跑 12s" copy.
import { createElement as h, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar, botState } from './mark.js'
import { workPhrase } from './cells.js'
import { currentPart } from './text.js'
import { reducedMotion } from './motion.js'

// The board stays closed until someone opens it: it reports on work, it does not ask
// for attention. `defaultOpen` only applies to a first run with no stored choice.
export const DEFAULT_CONFIG = Object.freeze({ defaultOpen: false, sort: 'section', density: 'two', showHistory: true })

const CONFIG_URL = './team-board.config.json'
const SORTS = new Set(['section', 'role'])
const DENSITIES = new Set(['two', 'one', 'compact'])

const COPY = {
  running: '在跑',
  waiting: '待办',
  idle: '空闲',
  updated: '最后更新',
  task: '任务',
  who: '谁',
  worked: '已跑',
  waited: '等待',
  idleFor: '空闲',
  standby: '待命',
  empty: '还没有收到名册，团队看板正在等数据',
  history: '最近做过',
  historyPending: '历史记录还没接上',
  close: '收起团队看板',
  ungrouped: '未分组',
  now: '刚刚',
}

/** Reads the board config. Missing file, bad JSON or a dead fetch fall back to defaults. */
export async function readBoardConfig(url = CONFIG_URL, fetchImpl) {
  const fallback = { ...DEFAULT_CONFIG }
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
  if (typeof doFetch !== 'function') return fallback
  try {
    const response = await doFetch(url, { cache: 'no-store', credentials: 'same-origin' })
    if (!response || response.ok === false) return fallback
    const raw = await response.json()
    const next = { ...fallback }
    if (typeof raw?.defaultOpen === 'boolean') next.defaultOpen = raw.defaultOpen
    if (SORTS.has(raw?.sort)) next.sort = raw.sort
    if (DENSITIES.has(raw?.density)) next.density = raw.density
    if (typeof raw?.showHistory === 'boolean') next.showHistory = raw.showHistory
    return next
  } catch {
    return fallback
  }
}

const doingOf = entry => ({
  tool: entry?.tool,
  said: entry?.said,
  note: entry?.note,
  target: entry?.target,
  switching: entry?.switching,
})

const pad2 = value => String(value).padStart(2, '0')

const clockOf = ms => {
  const at = new Date(ms)
  return `${pad2(at.getHours())}:${pad2(at.getMinutes())}:${pad2(at.getSeconds())}`
}

const durationOf = ms => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad2(seconds % 60)}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${pad2(minutes % 60)}m`
}

const roleOf = bot => (typeof bot?.role === 'string' ? bot.role : '')

const nameOf = bot => (typeof bot?.name === 'string' && bot.name !== '' ? bot.name : bot?.id ?? '')

/** The board's own reading of a Bot: what the live feed says it is doing right now. */
function entryOf(bot, work) {
  const entries = work?.bots ?? {}
  const doing = entries[bot.id]
  if (doing === undefined || doing === null) return undefined
  return doingOf(doing)
}

function isWaiting(roster, work, bot) {
  const part = currentPart(bot)
  if (roster?.questions && roster.questions[part] !== undefined) return true
  const approvals = work?.approvals ?? []
  return approvals.some(entry => entry?.botId === bot.id)
}

const HISTORY_STATE = { done: '完成', running: '进行中', working: '进行中', waiting: '等待' }
const historyState = state => HISTORY_STATE[state] ?? String(state ?? '')

/**
 * The numbers the closed board's tab carries: how many Bots are working right now and
 * how many are waiting on a person. The same reading the open board shows, so the tab
 * never disagrees with the panel behind it.
 */
export function boardSummary(roster, work) {
  const bots = visibleBots(roster)
  let running = 0
  let waiting = 0
  for (const bot of bots) {
    if (entryOf(bot, work) !== undefined) running += 1
    else if (isWaiting(roster, work, bot)) waiting += 1
  }
  return { running, waiting, idle: Math.max(0, bots.length - running - waiting), total: bots.length }
}

function visibleBots(roster) {
  const bots = roster?.bots ?? []
  const mainId = roster?.mainBotId
  return bots.filter(bot => bot && (!bot.hidden || bot.id === mainId))
}

function groupBots(bots, roster, sort) {
  if (sort === 'role') {
    const flat = [...bots].sort((a, b) => {
      const byRole = roleOf(a).localeCompare(roleOf(b))
      return byRole !== 0 ? byRole : nameOf(a).localeCompare(nameOf(b))
    })
    return flat.length === 0 ? [] : [{ id: 'role', name: '', bots: flat }]
  }
  const sections = roster?.sections ?? []
  const known = new Set(sections.map(section => section.id))
  const groups = sections.map(section => ({ id: section.id, name: section.name ?? '', bots: [] }))
  const loose = []
  for (const bot of bots) {
    const index = known.has(bot.sectionId) ? groups.findIndex(group => group.id === bot.sectionId) : -1
    if (index >= 0) groups[index].bots.push(bot)
    else loose.push(bot)
  }
  const kept = groups.filter(group => group.bots.length > 0)
  if (loose.length > 0) kept.push({ id: '_loose', name: COPY.ungrouped, bots: loose })
  return kept
}

function Row({ bot, doing, waiting, since, now, main }) {
  const running = doing !== undefined
  const state = botState(running, running ? 'working' : undefined, waiting)
  const elapsed = durationOf(now - since)
  // One line of state under the name: what the Bot is on, how long it has been waiting,
  // or that it is free. The old "谁：<name>" line only repeated the name above it.
  const detail = running ? workPhrase(doing) : waiting ? `${COPY.waited} ${elapsed}` : COPY.idleFor
  const meta = running ? `${COPY.worked} ${elapsed}` : ''
  const role = roleOf(bot)
  return h('article', {
    className: 'tb-row',
    'data-running': running || undefined,
    'data-waiting': (!running && waiting) || undefined,
    'data-main': main || undefined,
    'aria-label': `${nameOf(bot)}${role === '' ? '' : `（${role}）`}：${detail}${meta === '' ? '' : `，${meta}`}`,
  },
  h('div', { className: 'tb-avatar' }, h(BotAvatar, { bot, size: main ? 44 : 34, state, live: running, main })),
  h('div', { className: 'tb-body' },
    h('div', { className: 'tb-line' },
      h('span', { className: 'tb-name' }, nameOf(bot)),
      role === '' ? null : h('span', { className: 'tb-role' }, role),
      running ? h('span', { className: 'tb-pulse', 'aria-hidden': true }) : null,
      meta === '' ? null : h('span', { className: 'tb-elapsed' }, meta)),
    h('div', { className: 'tb-task', title: detail }, h('span', { className: 'tb-phrase' }, detail))))
}

export function TeamBoard({ roster, work, onClose, onOverview, configUrl = CONFIG_URL, now = Date.now }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [stamp, setStamp] = useState(() => now())
  const [tick, setTick] = useState(0)
  const [history, setHistory] = useState({ status: 'loading', rows: [] })
  const [historyOpen, setHistoryOpen] = useState(false)
  const sinceRef = useRef(new Map())

  useEffect(() => {
    let alive = true
    const load = () => {
      readBoardConfig(configUrl).then(next => {
        if (alive) setConfig(next)
      })
    }
    load()
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      window.removeEventListener('focus', onFocus)
    }
  }, [configUrl])

  const bots = useMemo(() => visibleBots(roster), [roster])
  const doingById = useMemo(() => {
    const map = new Map()
    for (const bot of bots) {
      const doing = entryOf(bot, work)
      if (doing !== undefined) map.set(bot.id, doing)
    }
    return map
  }, [bots, work])
  const waitingById = useMemo(() => {
    const map = new Set()
    for (const bot of bots) if (!doingById.has(bot.id) && isWaiting(roster, work, bot)) map.add(bot.id)
    return map
  }, [bots, roster, work, doingById])

  const runningCount = doingById.size
  const waitingCount = waitingById.size
  const idleCount = Math.max(0, bots.length - runningCount - waitingCount)
  const runningKey = [...doingById.keys()].sort().join(',')

  useEffect(() => {
    const at = now()
    const since = sinceRef.current
    for (const id of since.keys()) {
      if (!doingById.has(id) && !waitingById.has(id)) since.delete(id)
    }
    for (const id of doingById.keys()) if (!since.has(id)) since.set(id, at)
    for (const id of waitingById.keys()) if (!since.has(id)) since.set(id, at)
  }, [runningKey, waitingCount])

  useEffect(() => setStamp(now()), [roster, work])

  useEffect(() => {
    if (reducedMotion()) return undefined
    if (runningCount === 0) return undefined
    const timer = setTimeout(() => setTick(value => value + 1), 1000)
    return () => clearTimeout(timer)
  }, [tick, runningCount])

  useEffect(() => {
    const api = globalThis.window?.dsbot?.panelHistory
    if (typeof api !== 'function') {
      setHistory({ status: 'absent', rows: [] })
      return undefined
    }
    let alive = true
    Promise.resolve()
      .then(() => api({ limit: 50 }))
      .then(rows => {
        if (!alive) return
        const list = Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : []
        setHistory({ status: list.length > 0 ? 'rows' : 'empty', rows: list })
      })
      .catch(() => {
        if (alive) setHistory({ status: 'empty', rows: [] })
      })
    return () => {
      alive = false
    }
  }, [])

  const at = now()
  const groups = groupBots(bots, roster, config.sort)
  const showHistory = config.showHistory !== false && history.status !== 'absent'

  return h('section', { className: 'tb-board', 'data-density': config.density, 'aria-label': '团队看板' },
    h('header', { className: 'tb-head' },
      h('div', { className: 'tb-counts' },
        h('span', { className: 'tb-count', 'data-kind': 'running' }, h('b', null, String(runningCount)), COPY.running),
        h('span', { className: 'tb-count', 'data-kind': 'waiting' }, h('b', null, String(waitingCount)), COPY.waiting),
        h('span', { className: 'tb-count', 'data-kind': 'idle' }, h('b', null, String(idleCount)), COPY.idle)),
      h('div', { className: 'tb-head-end' },
        h('time', {
          className: 'tb-stamp',
          dateTime: new Date(stamp).toISOString(),
          title: `${COPY.updated} ${clockOf(stamp)}`,
        }, clockOf(stamp).slice(0, 5)),
        typeof onOverview === 'function'
          ? h('button', { type: 'button', className: 'tb-overview', title: '团队总览', onClick: onOverview }, '总览')
          : null,
        typeof onClose === 'function'
          ? h('button', { type: 'button', className: 'tb-close', 'aria-label': COPY.close, title: COPY.close, onClick: onClose }, '×')
          : null)),
    bots.length === 0
      ? h('div', { className: 'tb-empty', role: 'status' }, COPY.empty)
      : h('div', { className: 'tb-groups' },
        groups.map(group => h('div', { className: 'tb-group', key: group.id },
          group.name === '' ? null : h('div', { className: 'tb-group-name' }, h('span', null, group.name), h('span', { className: 'tb-group-count' }, String(group.bots.length))),
          h('div', { className: 'tb-rows' },
            group.bots.map(bot => h(Row, {
              key: bot.id,
              bot,
              doing: doingById.get(bot.id),
              waiting: waitingById.has(bot.id),
              since: sinceRef.current.get(bot.id) ?? at,
              now: at,
              main: bot.id === (roster?.mainBotId ?? '') || bot.main === true,
            })))))),
    showHistory
      ? h('footer', { className: 'tb-history' },
        h('button', {
          type: 'button', className: 'tb-history-toggle', 'aria-expanded': historyOpen,
          onClick: () => setHistoryOpen(value => !value),
        }, h('span', null, COPY.history), h('span', { className: 'tb-history-caret', 'aria-hidden': true }, historyOpen ? '▾' : '▸')),
        historyOpen
          ? history.status === 'rows'
            ? h('ul', { className: 'tb-history-rows' }, history.rows.slice(0, 50).map((row, index) => h('li', { key: `${row?.ts ?? index}:${row?.bot ?? ''}` },
              h('span', { className: 'tb-history-bot' }, String(row?.bot ?? '')),
              h('span', { className: 'tb-history-state' }, historyState(row?.state)),
              row?.doing ? h('span', { className: 'tb-history-doing' }, String(row.doing)) : null)))
            : h('p', { className: 'tb-history-note' }, COPY.historyPending)
          : null)
      : null)
}

export const TEAM_BOARD_CSS = `
.tb-board{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--bt-ink);background:transparent;font-size:12px;container-type:inline-size}
.tb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--bt-line)}
.tb-counts{display:flex;align-items:center;gap:5px;min-width:0}
.tb-count{display:inline-flex;align-items:baseline;gap:3px;padding:2px 7px;border-radius:6px;background:color-mix(in srgb,var(--bt-ink) 7%,transparent);font-size:11px;color:var(--bt-ink-2);white-space:nowrap}
.tb-count b{font-size:11.5px;font-weight:600;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.tb-count[data-kind=running] b{color:var(--bt-accent)}
.tb-count[data-kind=waiting] b{color:var(--bt-danger)}
.tb-head-end{margin-left:auto;display:flex;align-items:center;gap:2px;flex:none}
.tb-stamp{font-size:11px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;padding:0 2px}
.tb-overview{height:24px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--bt-ink-2);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.tb-overview:hover{background:var(--bt-hover);color:var(--bt-ink)}
.tb-close{width:24px;height:24px;border:0;border-radius:6px;background:none;color:var(--bt-ink-2);font-size:16px;line-height:1;cursor:pointer}
.tb-close:hover{background:var(--bt-hover);color:var(--bt-ink)}
.tb-groups{flex:1;min-height:0;overflow:auto;padding:8px 10px 12px}
.tb-group+.tb-group{margin-top:10px}
.tb-group-name{display:flex;align-items:baseline;gap:6px;padding:6px 4px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--bt-ink-3)}
.tb-group-count{font-weight:500;color:var(--bt-ink-3);opacity:.72;font-variant-numeric:tabular-nums}
.tb-rows{display:grid;grid-template-columns:minmax(0,1fr);gap:6px}
.tb-board[data-density=two] .tb-rows{grid-template-columns:minmax(0,1fr)}
@container (min-width:560px){.tb-board[data-density=two] .tb-rows{grid-template-columns:repeat(2,minmax(0,1fr))}}
.tb-row{min-width:0;display:flex;gap:9px;align-items:center;padding:8px 10px;border:.5px solid color-mix(in srgb,var(--bt-ink) 9%,transparent);border-radius:10px;background:color-mix(in srgb,var(--bt-main) 55%,transparent);transition:background-color .18s ease,border-color .18s ease}
.tb-row[data-main]{border-color:color-mix(in srgb,var(--bt-accent) 26%,transparent);background:color-mix(in srgb,var(--bt-accent) 5%,transparent);padding:11px 12px}
.tb-row[data-main] .tb-name{font-size:13.5px}
.tb-row[data-running]{border-color:color-mix(in srgb,var(--bt-accent) 42%,transparent);background:color-mix(in srgb,var(--bt-accent) 8%,transparent)}
.tb-row[data-waiting]{border-color:color-mix(in srgb,var(--bt-danger) 42%,transparent)}
.tb-avatar{flex:none;display:flex;align-items:center;justify-content:center}
.tb-body{min-width:0;flex:1;display:flex;flex-direction:column;gap:3px}
.tb-line{display:flex;align-items:center;gap:6px;min-width:0}
.tb-name{font-size:12.5px;font-weight:600;color:var(--bt-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-role{flex:none;font-size:10.5px;color:var(--bt-ink-3);padding:0 5px;border-radius:6px;border:.5px solid color-mix(in srgb,var(--bt-ink) 14%,transparent)}
.tb-elapsed{margin-left:auto;flex:none;font-size:10.5px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.tb-pulse{flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-accent);animation:tb-breathe 1.8s ease-in-out infinite}
@keyframes tb-breathe{0%,100%{opacity:.4;transform:scale(.85)}50%{opacity:1;transform:scale(1.15)}}
.tb-task{display:flex;min-width:0;font-size:11.5px;color:var(--bt-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tb-task>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.tb-board[data-density=compact] .tb-row{padding:6px 8px}
.tb-board[data-density=compact] .tb-role{display:none}
.tb-empty{padding:24px 14px;color:var(--bt-ink-3);text-align:center;line-height:1.6}
.tb-history{flex:none;border-top:.5px solid var(--bt-line);padding:6px 10px 8px}
.tb-history-toggle{display:flex;width:100%;align-items:center;gap:6px;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:11.5px;padding:4px;cursor:pointer;border-radius:6px}
.tb-history-toggle:hover{background:color-mix(in srgb,var(--bt-ink) 6%,transparent);color:var(--bt-ink)}
.tb-history-caret{margin-left:auto;color:var(--bt-ink-3)}
.tb-history-rows{margin:4px 0 0;padding:0;list-style:none;max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:3px}
.tb-history-rows li{display:flex;gap:8px;font-size:11px;color:var(--bt-ink-2)}
.tb-history-bot{flex:none;color:var(--bt-ink)}
.tb-history-state{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink-3)}
.tb-history-note{margin:6px 4px;font-size:11px;color:var(--bt-ink-3)}
@media (prefers-reduced-motion:reduce){.tb-row{transition:none}.tb-pulse{animation:none}}
`
