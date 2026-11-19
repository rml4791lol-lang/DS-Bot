// Mounts the team board as a panel of DS Bot's own, not in DSH's right column: that
// column is a single seat the shell already holds (its session panel), and claiming it
// would either throw or unseat that panel — and a throw while mounting takes the whole
// shell group down with it. This panel lives in the overlay list instead, so it can
// never collide with a seat.
import { createElement as h, useState } from 'react'
import { TeamBoard, boardSummary } from './team-board.js'
import { FALLBACK_SIDEBAR_WIDTH, frameLayout } from './frame-layout.js'

// Served by src/host/channel.js so the config can change without a rebuild.
export const TEAM_BOARD_CONFIG_URL = '/api/bot/team-board.config.json'

// The board opens only when the person using it left it open. Nothing unfolds it by
// itself: a panel that pops up on every launch interrupts the work it describes.
const OPEN_KEY = 'bt.teamBoard.open'
// Below this width a 380px card leaves the conversation too narrow to read; the board
// becomes a sheet docked beside the avatar rail instead of a floating column.
const SHEET_MAX = 583

const storedOpen = () => {
  try {
    const value = globalThis.localStorage?.getItem(OPEN_KEY)
    return value === null || value === undefined ? null : value === '1'
  } catch {
    return null
  }
}

const rememberOpen = (open) => {
  try {
    globalThis.localStorage?.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage off: the choice lasts this session, the panel still works.
  }
}

export const TEAM_BOARD_HOST_CSS = `
/* Beside the chat the board floats over its right edge as a glass column. It is only as
   tall as its roster: a full-height card over a nearly empty list covers chat for nothing. */
.tbh{position:fixed;top:8px;right:8px;bottom:auto;max-height:calc(100vh - 16px);width:min(380px,calc(100vw - 204px));display:flex;flex-direction:column;min-height:0;z-index:45;border:.5px solid var(--bt-glass-rim);border-radius:12px;background:var(--bt-glass-bg);-webkit-backdrop-filter:blur(24px) saturate(180%);backdrop-filter:blur(24px) saturate(180%);color:var(--bt-ink);box-shadow:var(--bt-glass-shadow);overflow:hidden}
/* Closed, it leaves one floating pill on the right edge carrying the count of Bots
   still working — a control you can find, not a strip glued to the window edge. */
.tbh-toggle{position:fixed;top:50%;right:6px;transform:translateY(-50%);z-index:45;display:flex;align-items:center;gap:6px;writing-mode:vertical-rl;border:.5px solid var(--bt-glass-rim);border-radius:10px;background:var(--bt-glass-bg);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);color:var(--bt-ink-2);padding:11px 6px;font:inherit;font-size:11px;line-height:1;letter-spacing:.02em;cursor:pointer;box-shadow:var(--bt-glass-shadow)}
.tbh-toggle:hover{color:var(--bt-ink);border-color:var(--bt-line-2)}
.tbh-badge{writing-mode:horizontal-tb;display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:color-mix(in srgb,var(--bt-ink) 16%,transparent);color:var(--bt-ink);font-size:10px;font-weight:600;font-variant-numeric:tabular-nums}
.tbh-badge[data-waiting=true]{background:color-mix(in srgb,var(--bt-danger) 30%,transparent)}
/* Narrow windows: the sheet starts beside the avatar rail and below the window's own
   title bar, so neither the rail nor the traffic lights cover its first column. */
@media (max-width:583px){
.tbh{top:var(--dsh-frame-overlay-top,8px);left:var(--tbh-left,8px);right:8px;bottom:auto;width:auto;max-height:46vh;border-radius:12px}
}
`

// Slot injection flattens the injected `hooks` face into one `useXxx` prop per
// source, so the board reads them as ordinary snapshot hooks (like TeamSidebar).
export function TeamBoardHost({ actions, useRoster, useWork, useFrame, useSidebarPref }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const frame = useFrame ? useFrame(value => value) : undefined
  const pref = useSidebarPref ? useSidebarPref(value => value) : 'open'
  // Nothing opens this panel but the person who opened it: a host config may ask for
  // the board, but that ask never wins over "starts closed". The counts it would have
  // shown live on the collapsed tab instead.
  const [open, setOpen] = useState(() => storedOpen() ?? false)

  const toggle = (next) => {
    rememberOpen(next)
    setOpen(next)
  }

  const viewport = frame?.viewport ?? (typeof globalThis.innerWidth === 'number' ? globalThis.innerWidth : 1024)
  const layout = frameLayout({ viewport, sidebarWidth: frame?.sidebarWidth ?? FALLBACK_SIDEBAR_WIDTH, pref })
  const sheet = viewport <= SHEET_MAX
  const summary = boardSummary(roster, work)

  if (!open) {
    const badge = summary.running + summary.waiting
    return h('button', {
      className: 'tbh-toggle',
      type: 'button',
      title: '团队看板',
      'aria-label': badge > 0 ? `打开团队看板，${summary.running} 在跑、${summary.waiting} 待办` : '打开团队看板',
      onClick: () => toggle(true),
    },
    badge > 0 ? h('span', { className: 'tbh-badge', 'data-waiting': summary.waiting > 0 || undefined, 'aria-hidden': true }, String(badge)) : null,
    h('span', null, '团队看板'))
  }
  return h('aside', {
    className: 'tbh',
    'aria-label': 'Team board',
    // The sheet starts past whatever the left column occupies (rail included).
    style: sheet ? { '--tbh-left': `${Math.max(8, layout.column)}px` } : undefined,
  },
  h(TeamBoard, {
    roster,
    work,
    onClose: () => toggle(false),
    onOverview: typeof actions?.openTeamOverview === 'function' ? actions.openTeamOverview : undefined,
    configUrl: TEAM_BOARD_CONFIG_URL,
  }))
}
