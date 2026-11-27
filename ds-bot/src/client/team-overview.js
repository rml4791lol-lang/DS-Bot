import { createElement as h, Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BotAvatar, RoomAvatar } from './mark.js'
import { Elapsed } from './cells.js'
import { relativeShort } from './text.js'
import { CloseIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, PlusIcon, PeopleIcon, GaugeIcon, MemoryIcon, FolderIcon, GoalIcon, TerminalIcon, RefreshIcon, PencilIcon, InfoIcon, QueueIcon, GlobeIcon } from './icons.js'
import { GitHubMark } from './connector-marks.js'
import { agentBoardModel, overviewModel, projectModel, workDetail } from './team-overview-model.js'
import { SiteSummary, SitesView, SITES_CSS } from './sites-page.js'
import { t } from './i18n.js'
import { SPRING_SHAPE } from './motion.js'

const stateText = row => row.alert ? t('Waiting for you')
  : row.doing?.switching ? t('Moving to a fresh Session')
    : row.running ? t('Working')
      : row.waitsOn.length > 0 ? t('Waiting for {names}', { names: row.waitsOn.join(t(' and ')) })
        : row.unread ? t('Unread activity')
          : t('Idle')

const rowDetail = row => row.running ? `${stateText(row)} · ${workDetail(row.doing) || t('Working')}` : stateText(row)
const entryState = entry => entry.kind === 'bot' ? entry.row.state
  : entry.row.approvals.length > 0 ? 'alert'
    : entry.row.running ? 'working'
      : entry.row.unread ? 'unread' : 'idle'

function StateDot({ state }) {
  return h('span', { className: 'bt-teamov-state-dot', 'data-state': state, 'aria-hidden': true })
}

function EmptyState() {
  return h('div', { className: 'bt-teamov-empty' },
    h(PeopleIcon),
    h('b', null, t('No team activity yet')),
    h('span', null, t('Bots, group chats and the work they hand to each other will appear here.')))
}

function Skeleton() {
  return h('div', { className: 'bt-teamov-skeleton', 'aria-busy': true, role: 'status' },
    h('span', { className: 'bt-sr' }, t('Loading team overview…')),
    h('i', { className: 'bt-teamov-skel-title' }),
    h('div', { className: 'bt-teamov-skel-stats' }, h('i'), h('i'), h('i')),
    h('i', { className: 'bt-teamov-skel-line' }),
    h('i', { className: 'bt-teamov-skel-line short' }))
}

function BootError() {
  return h('div', { className: 'bt-teamov-empty', role: 'alert' },
    h(GaugeIcon),
    h('b', null, t('Team state is unavailable')),
    h('span', null, t('The team could not be read. Close this view and try again after the host reconnects.')))
}

function Summary({ counts }) {
  const items = [
    [counts.running, t('Working'), 'working'],
    [counts.approvals + counts.questions, t('Need you'), 'needs'],
    [counts.waiting, t('Waiting for teammates'), 'teammates'],
    [counts.unread, t('Unread'), 'unread'],
  ]
  const pulse = counts.pulse
  const segments = [
    ['working', pulse.working, 'var(--bt-green)'],
    ['needs', pulse.needs, 'var(--bt-accent)'],
    ['waiting', pulse.waiting, 'var(--bt-star)'],
    ['unread', pulse.unread, 'color-mix(in srgb,var(--bt-accent) 58%,var(--bt-line-2))'],
    ['idle', pulse.idle, 'var(--bt-line-2)'],
  ].filter(([, value]) => value > 0)
  const total = Math.max(1, pulse.total)
  let at = 0
  const stops = segments.map(([, value, color]) => {
    const from = at / total * 100
    at += value
    return `${color} ${from}% ${at / total * 100}%`
  })
  const label = [
    [t('Working'), pulse.working],
    [t('Need you'), pulse.needs],
    [t('Waiting for teammates'), pulse.waiting],
    [t('Unread'), pulse.unread],
    [t('Idle'), pulse.idle],
  ].map(([name, value]) => `${name}: ${value}`).join(', ')
  return h('div', { className: 'bt-teamov-summary' },
    h('div', { className: 'bt-teamov-ring', role: 'img', 'aria-label': label, style: { '--bt-teamov-ring': stops.length > 0 ? `conic-gradient(${stops.join(',')})` : 'conic-gradient(var(--bt-line-2) 0 100%)' } },
      h('span', null, h('b', null, pulse.total), h('small', null, t('Team')))),
    h('div', { className: 'bt-teamov-stats' }, items.map(([value, label, kind]) =>
      h('span', { key: label, className: 'bt-teamov-stat', 'data-kind': kind },
        h('b', null, value), h('small', null, label)))))
}

function Attention({ model, openEntry }) {
  const rows = [
    ...model.approvals.map(approval => ({
      key: `approval:${approval.id}`,
      kind: 'approval',
      approval,
      bot: model.botRows.get(approval.botId)?.bot,
      target: approval.roomId === undefined ? model.botRows.get(approval.botId)?.bot : model.roomRows.get(approval.roomId)?.room,
      at: approval.at,
    })),
    ...model.questions.map(entry => ({ key: `question:${entry.question.id}`, kind: 'question', entry, bot: entry.owner, target: entry.owner, at: entry.at })),
  ].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  if (rows.length === 0) return null
  return h('section', { className: 'bt-teamov-section' },
    h('div', { className: 'bt-teamov-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Needs you')), h('h3', null, t('Decisions waiting'))),
      h('span', { className: 'bt-teamov-count' }, rows.length)),
    h('div', { className: 'bt-teamov-list' }, rows.map(row =>
      h('button', { key: row.key, type: 'button', className: 'bt-teamov-attention', onClick: () => openEntry(row.target ?? row.bot) },
        row.bot ? h(BotAvatar, { bot: row.bot, size: 30, state: 'alert' }) : h('span', { className: 'bt-teamov-attention-icon' }, h(ClockIcon)),
        h('span', { className: 'bt-teamov-row-text' },
          h('b', null, row.kind === 'approval' ? row.approval.tool || t('Approval') : row.entry.question.question || t('Question')),
          h('small', null, row.kind === 'approval' ? row.approval.reason || t('Waiting for your approval') : row.entry.question.detail || t('Waiting for your answer'))),
        Number.isFinite(row.at) ? h(Elapsed, { at: row.at, className: 'bt-teamov-age' }) : null,
        h(ChevronRightIcon)))))
}

function Activity({ model, openEntry }) {
  if (model.activities.length === 0) return null
  return h('section', { className: 'bt-teamov-section' },
    h('div', { className: 'bt-teamov-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Live work')), h('h3', null, t('Happening now'))),
      h('span', { className: 'bt-teamov-count' }, model.activities.length)),
    h('div', { className: 'bt-teamov-list' }, model.activities.map(entry =>
      h('button', { key: entry.key, type: 'button', className: 'bt-teamov-row bt-teamov-live-row', onClick: () => openEntry(entry.kind === 'room' ? entry.room : entry.bot) },
        h('span', { className: 'bt-teamov-activity-avatar', 'data-state': entry.row.state },
          h(BotAvatar, { bot: entry.bot, size: 34, state: entry.row.state })),
        h('span', { className: 'bt-teamov-row-text' },
          h('b', null, entry.bot.name, entry.room ? h('span', { className: 'bt-teamov-context' }, ` · ${entry.room.name}`) : null),
          h('small', null, entry.doing?.switching ? t(entry.doing.folder ? 'Moving this chat to its new folder' : 'Moving to a fresh Session') : workDetail(entry.doing) || t('Working'))),
        Number.isFinite(entry.since) ? h(Elapsed, { at: entry.since, className: 'bt-teamov-age' }) : null,
        h(ChevronRightIcon)))))
}

function TeamSections({ model, openEntry }) {
  return h('section', { className: 'bt-teamov-section' },
    h('div', { className: 'bt-teamov-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Team')), h('h3', null, t('Bots and groups'))),
      h('span', { className: 'bt-teamov-count' }, model.counts.bots + model.counts.groups)),
    model.sections.map(section => h('div', { key: section.id, className: 'bt-teamov-group' },
      section.name ? h('div', { className: 'bt-teamov-group-head' },
        h('b', null, section.name),
        h('span', { className: 'bt-teamov-group-tail' },
          h('span', { className: 'bt-teamov-mini-pulse', 'aria-hidden': true }, section.entries.slice(0, 10).map(entry => h('i', { key: `${entry.kind}:${entry.id}`, 'data-state': entryState(entry) }))),
          h('span', { className: 'bt-teamov-group-count' }, section.entries.length))) : null,
      section.entries.map(entry => entry.kind === 'bot'
        ? h('button', { key: `bot:${entry.id}`, type: 'button', className: 'bt-teamov-row', onClick: () => openEntry(entry.row.bot) },
          h(BotAvatar, { bot: entry.row.bot, size: 34, state: entry.row.state }),
          h('span', { className: 'bt-teamov-row-text' }, h('b', null, entry.row.bot.name, h(StateDot, { state: entry.row.state })), h('small', null, rowDetail(entry.row))),
          h(ChevronRightIcon))
        : h('button', { key: `room:${entry.id}`, type: 'button', className: 'bt-teamov-row', onClick: () => openEntry(entry.row.room) },
          h(RoomAvatar, { room: entry.row.room, roster: model.roster, size: 34 }),
          h('span', { className: 'bt-teamov-row-text' }, h('b', null, entry.row.room.name), h('small', null, entry.row.running ? t('{count} members working', { count: entry.row.members.length }) : t('{count} members', { count: entry.row.room.members.length }))),
          h(ChevronRightIcon))))))
}

function Recent({ model, openEntry }) {
  if (model.recent.length === 0) return null
  return h('section', { className: 'bt-teamov-section' },
    h('div', { className: 'bt-teamov-head' }, h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Recent records')), h('h3', null, t('What changed')) )),
    h('div', { className: 'bt-teamov-list' }, model.recent.slice(0, 8).map(entry =>
      h('button', { key: entry.key, type: 'button', className: 'bt-teamov-record', onClick: () => openEntry(entry.kind === 'bot' ? entry.row.bot : entry.row.room) },
        h('i', { className: 'bt-teamov-record-dot', 'data-state': entry.kind === 'bot' ? entry.row.state : roomState(entry.row), 'aria-hidden': true }),
        h('span', { className: 'bt-teamov-record-time' }, relativeShort(entry.at)),
        h('span', { className: 'bt-teamov-row-text' }, h('b', null, entry.name), h('small', null, entry.preview || t('No message preview'))),
        h(ChevronRightIcon)))))
}

function Learning({ model, openEntry }) {
  const rows = Object.entries(model.learning ?? {}).flatMap(([botId, proposals]) => (proposals ?? []).map(proposal => ({ botId, proposal }))).slice(0, 3)
  if (rows.length === 0) return null
  return h('section', { className: 'bt-teamov-section' },
    h('div', { className: 'bt-teamov-head' }, h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Learning')), h('h3', null, t('Proposals waiting')))),
    h('div', { className: 'bt-teamov-list' }, rows.map(({ botId, proposal }) => {
      const bot = model.botRows.get(botId)?.bot
      return h('button', { key: proposal.id, type: 'button', className: 'bt-teamov-row', onClick: () => openEntry(bot) },
        h('span', { className: 'bt-teamov-attention-icon' }, h(MemoryIcon)),
        h('span', { className: 'bt-teamov-row-text' }, h('b', null, proposal.name || t('Bot improvement')), h('small', null, proposal.description || proposal.kind || t('Awaiting approval'))),
        h(ChevronRightIcon))
    })))
}


const roomState = row => row.approvals.length > 0 ? 'alert' : row.running ? 'working' : row.unread ? 'unread' : 'idle'
const projectName = project => project.name || t('Ungrouped')
const shortPath = path => String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? path
const EMPTY_SITE_DIRECTORY = { version: 1, groups: [], sites: [], counts: { total: 0, online: 0, local: 0, attention: 0, groups: 0, archived: 0 } }
const timestampOf = value => Number.isFinite(value) ? value : (Date.parse(String(value ?? '')) || 0)
const ownerOf = (model, id) => model.botRows.get(id)?.bot ?? model.roomRows.get(id)?.room
const stateWord = state => state === 'alert' || state === 'needs' ? t('Need you')
  : state === 'working' || state === 'thinking' || state === 'searching' || state === 'sending' ? t('Working')
    : state === 'waiting' ? t('Waiting for teammates')
      : state === 'unread' ? t('Unread') : t('Idle')

function ProjectSummary({ counts }) {
  const items = [
    [counts.total, t('Projects'), 'projects'],
    [counts.active, t('Active'), 'working'],
    [counts.needs, t('Need you'), 'needs'],
    [counts.work, t('Open work'), 'work'],
    [counts.standards, t('With rules'), 'rules'],
  ]
  return h('div', { className: 'bt-teamov-portfolio' },
    h('div', { className: 'bt-teamov-portfolio-mark' }, h(FolderIcon)),
    h('div', { className: 'bt-teamov-portfolio-copy' },
      h('b', null, t('Project portfolio')),
      h('span', null, t('Live work, memory and captured standards'))),
    h('div', { className: 'bt-teamov-portfolio-stats' }, items.map(([value, label, kind]) =>
      h('span', { key: label, 'data-kind': kind }, h('b', null, value), h('small', null, label)))))
}

function AgentSummary({ counts }) {
  const items = [
    [counts.total, t('Agents'), 'agents'],
    [counts.working, t('Working'), 'working'],
    [counts.needs, t('Need you'), 'needs'],
    [counts.improving, t('Learning queued'), 'learning'],
  ]
  return h('div', { className: 'bt-teamov-portfolio' },
    h('div', { className: 'bt-teamov-portfolio-mark' }, h(GaugeIcon)),
    h('div', { className: 'bt-teamov-portfolio-copy' },
      h('b', null, t('Agent health')),
      h('span', null, t('Runtime, learning and standards evidence'))),
    h('div', { className: 'bt-teamov-portfolio-stats' }, items.map(([value, label, kind]) =>
      h('span', { key: label, 'data-kind': kind }, h('b', null, value), h('small', null, label)))))
}

function DataTabs({ tab, setTab, model, projectCount, agentCount, siteCount, busy, refresh }) {
  const tabs = [
    ['team', t('Team'), PeopleIcon, model.counts.bots + model.counts.groups],
    ['projects', t('Projects'), FolderIcon, projectCount],
    ['agents', t('Agents'), GaugeIcon, agentCount],
    ['sites', t('Published'), GlobeIcon, siteCount],
  ]
  const onKey = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const tablist = event.currentTarget
    const at = tabs.findIndex(([id]) => id === tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    setTab(tabs[next][0])
    requestAnimationFrame(() => tablist.children?.[next]?.focus())
  }
  return h('div', { className: 'bt-teamov-databar' },
    h('div', { className: 'bt-teamov-tabs', role: 'tablist', 'aria-label': t('Overview sections'), onKeyDown: onKey }, tabs.map(([id, label, Icon, count]) =>
      h('button', {
        key: id, type: 'button', role: 'tab', className: 'bt-teamov-tabitem', tabIndex: tab === id ? 0 : -1,
        'aria-selected': tab === id, 'aria-controls': `bt-teamov-${id}`, onClick: () => setTab(id),
      }, h(Icon), h('span', null, label), count === null ? null : h('i', null, count)))),
    tab === 'team' ? null : h('button', { type: 'button', className: 'bt-teamov-refresh', disabled: busy, 'aria-label': busy ? t('Refreshing…') : t('Refresh'), title: busy ? t('Refreshing…') : t('Refresh'), onClick: refresh },
      h(RefreshIcon), h('span', null, busy ? t('Refreshing…') : t('Refresh'))))
}

const completionWord = status => status === 'complete' ? t('Goal reached')
  : status === 'verified' ? t('Checks verified')
    : status === 'standards' ? t('Standards incomplete')
      : status === 'attention' ? t('Needs your decision')
      : status === 'failing' ? t('Checks need attention')
        : status === 'working' ? t('In progress')
          : status === 'paused' ? t('Paused')
            : status === 'planned' ? t('Planned')
              : t('Plan not set')

const knowledgeWord = kind => kind === 'memory' ? t('Decisions')
  : kind === 'rules' ? t('Rules')
    : kind === 'sources' ? t('Sources')
      : kind === 'skills' ? t('Learned skills')
        : kind === 'checks' ? t('Configured checks')
          : t('Verified results')

const goalActionWord = action => action === 'draft' ? t('Goal drafted')
  : action === 'start' ? t('Goal started')
    : action === 'pass' ? t('Stage passed')
      : action === 'rework' ? t('Stage sent back')
        : action === 'task' ? t('Task updated')
          : action === 'revise' ? t('Goal revised')
            : action === 'pause' ? t('Goal paused')
              : action === 'resume' ? t('Goal resumed')
                : action === 'complete' ? t('Goal reached')
                  : action === 'stop' ? t('Goal stopped')
                    : t('Goal updated')

const eventActionWord = event => event.kind === 'goal' ? goalActionWord(event.action)
  : event.kind === 'change' && event.sourceKind === 'github' ? t('GitHub updated')
  : event.kind === 'change' && event.action === 'committed' ? t('Committed')
    : event.kind === 'change' && event.action === 'working' ? t('Uncommitted changes')
      : event.kind === 'change' && event.action === 'detected' ? t('Files changed')
        : event.kind === 'progress' ? t('Progress recorded')
          : event.kind === 'decision' ? t('Decision recorded')
            : event.kind === 'checkpoint' ? t('Checkpoint recorded')
              : event.kind === 'change' ? t('Change recorded')
  : event.kind === 'memory' ? t('Memory saved')
    : event.kind === 'skill' ? t('Learning approved')
      : event.kind === 'rules' ? t('Rules updated')
        : event.kind === 'document' ? t('Document updated')
          : event.kind === 'source' ? t('Source reviewed')
            : event.kind === 'check' ? t('Checks recorded')
              : t('Work recorded')

const eventOriginWord = event => event.sourceKind === 'bot' ? t('Reported by Bot')
  : event.sourceKind === 'automatic' || event.sourceKind === 'filesystem' ? t('Observed automatically')
    : event.sourceKind === 'git' ? t('Read from Git')
      : event.sourceKind === 'github' ? t('Read from GitHub')
      : t('Recorded')

const eventTitle = event => event.kind === 'change' && event.action === 'working'
  ? t('{count} uncommitted files', { count: event.files?.length ?? 0 })
  : event.kind === 'change' && event.action === 'detected' && event.sourceKind !== 'github' ? t('Project files changed')
    : event.title || ''

function eventProgressText(event) {
  if (event.before && event.after) return `${event.before} → ${event.after}`
  if (event.after) return event.after
  if (event.before) return event.before
  return ''
}

const profileWord = id => id === 'miniprogram' ? t('Mini program')
  : id === 'video' ? t('Video')
    : id === 'web' ? t('Web')
      : id === 'app' ? t('App')
        : id === 'backend' ? t('Backend')
          : id === 'mixed' ? t('Mixed')
            : t('Generic')

const fileRoleWord = role => role === 'rules' ? t('Project rules')
  : role === 'description' ? t('Project document')
    : role === 'commands' ? t('Commands')
      : role === 'standards' ? t('Standard pack')
        : role === 'results' ? t('Check results')
          : role === 'integration' ? t('Task source')
            : role === 'project' ? t('Project marker')
              : t('Required file')

function KnowledgeGlyph({ kind }) {
  return kind === 'memory' ? h(MemoryIcon)
    : kind === 'rules' || kind === 'document' ? h(PencilIcon)
      : kind === 'sources' || kind === 'source' ? h(InfoIcon)
        : kind === 'skills' ? h(GoalIcon)
          : h(TerminalIcon)
}

function ProjectRail({ project }) {
  const goal = project.goal
  const work = [...project.bots.map(row => row.state), ...project.rooms.map(roomState)]
  return h('div', { className: 'bt-teamov-project-rail' },
    h('div', { className: 'bt-teamov-rail-row', 'data-kind': 'plan' },
      h('span', null, h(GoalIcon), t('Plan')),
      goal.stages.length > 0
        ? h('div', { className: 'bt-teamov-flow-dots' }, goal.stages.map((stage, index) => h('i', {
          key: index, 'data-state': stage.status === 'passed' ? 'done' : stage.current ? 'current' : 'todo', title: stage.title,
        })))
        : h('small', null, t('Not defined')),
      h('b', null, goal.total > 0 ? `${goal.passed}/${goal.total}` : '—')),
    h('div', { className: 'bt-teamov-rail-row', 'data-kind': 'work' },
      h('span', null, h(PeopleIcon), t('Work')),
      work.length > 0
        ? h('div', { className: 'bt-teamov-flow-dots' }, work.map((state, index) => h('i', { key: index, 'data-state': state })))
        : h('small', null, t('Quiet')),
      h('b', null, project.state.running > 0 ? project.state.running : '—')),
    h('div', { className: 'bt-teamov-rail-row', 'data-kind': 'evidence' },
      h('span', null, h(CheckIcon), t('Evidence')),
      h('div', { className: 'bt-teamov-evidence-dots' }, project.standards.evidence.map((on, index) => h('i', { key: index, 'data-on': on || undefined }))),
      h('b', null, `${project.standards.covered}/4`)))
}

function MetricSignal({ label, value, detail, tone }) {
  return h('div', { className: 'bt-teamov-signal', 'data-tone': tone },
    h('span', null, label), h('b', null, value), h('small', null, detail))
}

function GoalFlow({ project }) {
  if (project.goal.stages.length === 0) {
    return h('div', { className: 'bt-teamov-no-plan' },
      h(GoalIcon),
      h('span', null, h('b', null, t('No acceptance plan yet')), h('small', null, t('Set a Goal in the project conversation to make progress measurable.'))))
  }
  return h('div', { className: 'bt-teamov-goal-flow', role: 'list', 'aria-label': t('Goal stages') },
    project.goal.stages.map((stage, index) => h('div', {
      key: index, role: 'listitem', className: 'bt-teamov-goal-node',
      'data-state': stage.status === 'passed' ? 'done' : stage.current ? 'current' : 'todo',
    }, h('i', null, stage.status === 'passed' ? h(CheckIcon) : index + 1), h('span', null, stage.title))))
}

function CheckMatrix({ project }) {
  const rows = project.completion.checks.rows
  if (rows.length === 0) return h('div', { className: 'bt-teamov-quiet-block' }, h(TerminalIcon), h('span', null, t('No checks configured')))
  return h('div', { className: 'bt-teamov-check-matrix' }, rows.map(row => h('div', { key: row.name, 'data-state': row.status },
    h('i', { 'aria-hidden': true }, row.status === 'passed' ? h(CheckIcon) : row.status === 'failed' ? h(CloseIcon) : h(ClockIcon)),
    h('span', null, row.name),
    h('small', null, row.status === 'passed' ? t('Passed')
      : row.status === 'failed' ? t('Failed')
        : row.status === 'unknown' ? t('Unverified') : t('Not recorded')))))
}

const workStateWord = state => state === 'merged' ? t('Merged')
  : state === 'closed' ? t('Closed')
    : state === 'draft' ? t('Draft')
      : t('Open')

const checksWord = checks => checks?.status === 'failed' ? t('Checks failed')
  : checks?.status === 'pending' ? t('Checks pending')
    : checks?.status === 'passed' ? t('Checks passed')
      : checks?.status === 'unknown' ? t('Checks unavailable')
        : t('No checks')

const reviewWord = decision => decision === 'approved' ? t('Review approved')
  : decision === 'changes_requested' ? t('Changes requested')
    : ''

function WorkItemsBoard({ project, actions }) {
  const data = project.workItems
  const [kind, setKind] = useState('issues')
  const [scope, setScope] = useState('all')
  if (data === undefined || data.status === 'not-linked' || data.status === 'disabled') return null
  if (data.status !== 'ok' && data.status !== 'stale') {
    const message = data.status === 'needs-auth' ? t('GitHub sign-in needed')
      : data.status === 'gh-missing' ? t('GitHub CLI or connector needed')
        : data.status === 'not-found' ? t('Repository not found')
          : t('GitHub could not be read')
    return h('section', { className: 'bt-teamov-workitems', 'data-state': data.status },
      h('div', { className: 'bt-teamov-board-head' },
        h('div', null, h('span', { className: 'bt-teamov-kicker bt-teamov-work-kicker' }, h(QueueIcon), t('GitHub')), h('h4', null, t('Project work'))),
        h('span', { className: 'bt-teamov-board-badge', 'data-warning': true }, t('Needs setup'))),
      h('div', { className: 'bt-teamov-work-empty' },
        h(GitHubMark),
        h('span', null, h('b', null, message), h('small', null, data.error || t('Connect a source to see issues and pull requests.'))),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openConnectors() }, t('Open connectors'))))
  }
  const kindItems = data.items.filter(item => kind === 'issues' ? item.type === 'issue' : item.type === 'pr')
  const items = kindItems.filter(item => scope === 'all' ? true : scope === 'mine' ? item.mine : item.needsReview)
  const shown = items.slice(0, 8)
  const repo = data.repo
  const base = repo?.url ?? null
  const viewAll = base ? `${base}/${kind === 'issues' ? 'issues' : 'pulls'}` : null
  const scopeItems = [['all', t('All')], ['mine', t('Mine')], ...(kind === 'prs' ? [['review', t('Review')]] : [])]
  const detail = data.stale ? t('Stale') : data.repos.length > 1 ? t('{count} repositories', { count: data.repos.length }) : repo?.slug ?? ''
  return h('section', { className: 'bt-teamov-workitems', 'data-state': data.stale ? 'stale' : data.status },
    h('div', { className: 'bt-teamov-board-head' },
      h('div', { className: 'bt-teamov-work-title' },
        h('span', { className: 'bt-teamov-kicker bt-teamov-work-kicker' }, h(QueueIcon), t('GitHub')),
        h('h4', null, t('Project work'), detail ? h('span', { className: 'bt-teamov-profile-note' }, detail) : null)),
      h('span', { className: 'bt-teamov-board-badge', 'data-warning': data.stale || undefined }, h('i', null), `${t('Auto')} · ${data.refreshSeconds || 60}s`)),
    h('div', { className: 'bt-teamov-work-toolbar' },
      h('div', { className: 'bt-teamov-work-tabs', role: 'tablist', 'aria-label': t('Project work') },
        h('button', { type: 'button', role: 'tab', 'aria-selected': kind === 'issues', 'data-active': kind === 'issues' || undefined, onClick: () => { setKind('issues'); setScope('all') } }, t('Issues'), h('i', null, data.counts.issues)),
        h('button', { type: 'button', role: 'tab', 'aria-selected': kind === 'prs', 'data-active': kind === 'prs' || undefined, onClick: () => { setKind('prs'); setScope('all') } }, t('Pull requests'), h('i', null, data.counts.pullRequests))),
      h('div', { className: 'bt-teamov-work-filters' }, scopeItems.map(([id, label]) =>
        h('button', { key: id, type: 'button', 'data-active': scope === id || undefined, onClick: () => setScope(id) }, label)))),
    shown.length === 0 ? h('div', { className: 'bt-teamov-work-empty compact' }, h(GitHubMark), h('span', null, t('No work items')))
      : h('div', { className: 'bt-teamov-work-list' }, shown.map(item => {
        const row = h(Fragment, null,
          h('span', { className: 'bt-teamov-work-number' }, h('b', null, `#${item.number}`), h('small', null, item.type === 'pr' ? 'PR' : 'Issue')),
          h('span', { className: 'bt-teamov-work-copy' },
            h('b', null, item.title),
            h('small', null,
              item.author ? t('by {name}', { name: item.author }) : '',
              data.repos.length > 1 && item.repo?.slug ? ` · ${item.repo.slug}` : '',
              item.reviewDecision ? ` · ${reviewWord(item.reviewDecision)}` : '')),
          h('span', { className: 'bt-teamov-work-signals' },
            h('i', { 'data-state': item.draft ? 'draft' : item.state }, workStateWord(item.draft ? 'draft' : item.state)),
            item.type === 'pr' ? h('i', { 'data-check': item.checks?.status }, checksWord(item.checks)) : null),
          h('time', null, relativeShort(item.updatedAt)),
          h(ChevronRightIcon))
        return item.url
          ? h('a', { key: `${item.repo?.slug}:${item.type}:${item.number}`, className: 'bt-teamov-work-row', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, row)
          : h('div', { key: `${item.repo?.slug}:${item.type}:${item.number}`, className: 'bt-teamov-work-row' }, row)
      })),
    h('div', { className: 'bt-teamov-work-foot' },
      h('span', null, data.fetchedAt ? t('Updated {time}', { time: relativeShort(data.fetchedAt) }) : ''),
      viewAll ? h('a', { href: viewAll, target: '_blank', rel: 'noopener noreferrer' }, t('View on GitHub'), h(ChevronRightIcon)) : null))
}

function CompletionBoard({ project }) {
  const checks = project.completion.checks
  const recorded = project.standards.quality
  return h('section', { className: 'bt-teamov-completion', 'data-status': project.completion.status },
    h('div', { className: 'bt-teamov-board-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Completion model')), h('h4', null, completionWord(project.completion.status))),
      h('span', { className: 'bt-teamov-board-badge' }, h('i', null), t('Auto'))),
    h('div', { className: 'bt-teamov-signal-grid' },
      h(MetricSignal, { label: t('Plan'), value: project.goal.total > 0 ? `${project.goal.passed}/${project.goal.total}` : '—', detail: project.goal.current || (project.goal.total > 0 ? t('Stages passed') : t('No Goal')), tone: project.goal.total > 0 ? 'neutral' : 'quiet' }),
      h(MetricSignal, { label: t('Recorded checks'), value: recorded ? `${checks.passed}/${checks.expected}` : '—', detail: recorded ? (checks.failed > 0 ? t('{count} failing', { count: checks.failed }) : t('All recorded checks passed')) : t('No result recorded'), tone: recorded ? (checks.failed > 0 ? 'danger' : 'good') : 'quiet' }),
      h(MetricSignal, { label: t('Evidence'), value: `${project.standards.covered}/4`, detail: project.completion.requirements.missing > 0 ? t('{count} required files missing', { count: project.completion.requirements.missing }) : project.completion.requirements.checksMissing > 0 ? t('{count} required checks unrecorded', { count: project.completion.requirements.checksMissing }) : t('Folder · rules · sources · checks'), tone: project.completion.requirements.missing > 0 || project.completion.requirements.checksMissing > 0 ? 'danger' : project.standards.covered === 4 ? 'good' : 'neutral' })),
    h('div', { className: 'bt-teamov-completion-grid' },
      h('div', { className: 'bt-teamov-board-block' },
        h('div', { className: 'bt-teamov-block-title' }, h(GoalIcon), h('b', null, t('Acceptance flow')), h('span', null, project.goal.title || t('No Goal'))),
        h(GoalFlow, { project })),
      h('div', { className: 'bt-teamov-board-block' },
        h('div', { className: 'bt-teamov-block-title' }, h(TerminalIcon), h('b', null, t('Check matrix')), h('span', null, recorded ? t('Recorded {time}', { time: relativeShort(timestampOf(recorded.checkedAt)) }) : t('Unverified'))),
        h(CheckMatrix, { project }))))
}

function EvidenceStrip({ evidence, compact = false }) {
  const labels = [t('Folder'), t('Rules'), t('Sources'), t('Checks')]
  return h('div', { className: compact ? 'bt-teamov-evidence compact' : 'bt-teamov-evidence', role: 'img', 'aria-label': labels.map((label, index) => `${label}: ${evidence[index] ? t('Found') : t('Missing')}`).join(', ') },
    labels.map((label, index) => h('span', { key: label, 'data-on': evidence[index] || undefined },
      h('i'), compact ? null : h('small', null, label))))
}

function StandardsDossier({ project }) {
  const standards = project.standards
  const files = standards.adoptedFiles.slice(0, 10)
  const presentFiles = standards.adoptedFiles.filter(file => file.exists).length
  const sources = standards.sourceDetails.slice(0, 5)
  const experiences = [
    ...standards.folders.flatMap(fact => (fact.standards.ruleLines ?? fact.standards.headings ?? []).map(text => ({ text, source: fact.standards.file }))),
    ...standards.documents.map(doc => ({ text: doc.excerpt || (doc.headings ?? []).join(' · '), source: doc.path })),
    ...project.memory.topics.map(text => ({ text, source: t('Memory') })),
    ...project.learning.settled.filter(entry => entry.outcome === 'approved').map(entry => ({ text: entry.name || entry.folder || t('Learned skill'), source: t('Learning') })),
  ].filter((entry, index, all) => entry.text && all.findIndex(other => other.text === entry.text && other.source === entry.source) === index).slice(0, 12)
  const fileRows = files.map(file => h('div', { key: `${file.folder}:${file.path}:${file.role}`, 'data-missing': !file.exists || undefined },
    h('i', null, file.exists ? h(CheckIcon) : h(CloseIcon)),
    h('span', null, h('b', null, file.path), h('small', null, fileRoleWord(file.role))),
    file.findings?.rules !== undefined ? h('em', null, `${file.findings.rules}`) : null))
  const sourceRows = sources.map(source => {
    const checkedAt = timestampOf(source.checkedAt)
    const stale = checkedAt === 0 || Date.now() - checkedAt > 30 * 24 * 60 * 60 * 1000
    const detail = [
      (source.scope ?? []).join(' · '),
      source.version ? `v${source.version}` : null,
      checkedAt ? relativeShort(checkedAt) : t('Not reviewed'),
      stale ? t('Needs review') : null,
    ].filter(Boolean).join(' · ') || t('Reference')
    return h('div', { key: source.url || source.name, 'data-stale': stale || undefined },
      h('span', null, h('b', null, source.name), h('small', null, detail)),
      source.url ? h('a', { href: source.url, target: '_blank', rel: 'noreferrer' }, t('Open')) : null)
  })
  const experienceChips = experiences.map((entry, index) => h('span', { key: `${entry.text}:${index}`, title: entry.source },
    h('b', null, entry.text), h('small', null, entry.source)))
  return h('section', { className: 'bt-teamov-standards-dossier' },
    h('div', { className: 'bt-teamov-board-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Standards')), h('h4', null, profileWord(standards.profile?.id), h('span', { className: 'bt-teamov-profile-note' }, standards.profile?.declared ? t('Declared pack') : t('Detected from files')))),
      h('span', { className: 'bt-teamov-board-badge', 'data-warning': presentFiles < standards.adoptedFiles.length || undefined }, t('{present} of {total} files', { present: presentFiles, total: standards.adoptedFiles.length }))),
    h('div', { className: 'bt-teamov-standards-grid' },
      h('div', { className: 'bt-teamov-standard-block' },
        h('div', { className: 'bt-teamov-block-title' }, h(PencilIcon), h('b', null, t('Adopted files')), h('span', null, t('What the rules come from'))),
        h('div', { className: 'bt-teamov-file-list' }, files.length === 0 ? h('small', null, t('No adopted files found')) : fileRows)),
      h('div', { className: 'bt-teamov-standard-block' },
        h('div', { className: 'bt-teamov-block-title' }, h(InfoIcon), h('b', null, t('Official sources')), h('span', null, t('Declared references'))),
        h('div', { className: 'bt-teamov-source-list' }, sources.length === 0 ? h('small', null, t('No official sources declared')) : sourceRows)),
      h('div', { className: 'bt-teamov-standard-block' },
        h('div', { className: 'bt-teamov-block-title' }, h(MemoryIcon), h('b', null, t('Experience captured')), h('span', null, t('Rules and lessons'))),
        h('div', { className: 'bt-teamov-experience-chips' }, experiences.length === 0 ? h('small', null, t('No experience captured yet')) : experienceChips))))
}

function KnowledgeBoard({ project }) {
  return h('section', { className: 'bt-teamov-knowledge' },
    h('div', { className: 'bt-teamov-board-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Experience')), h('h4', null, t('Knowledge captured'))),
      h('span', { className: 'bt-teamov-count' }, project.experience.count)),
    h('div', { className: 'bt-teamov-knowledge-grid' }, project.experience.knowledge.map(item =>
      h('div', { key: item.kind, className: 'bt-teamov-knowledge-tile', 'data-kind': item.kind },
        h('span', null, h(KnowledgeGlyph, { kind: item.kind })),
        h('b', null, item.count),
        h('small', null, knowledgeWord(item.kind))))),
    project.standards.sources.length > 0 ? h('div', { className: 'bt-teamov-source-row' }, project.standards.sources.slice(0, 3).map(source =>
      h('a', { key: source, href: source, target: '_blank', rel: 'noreferrer', title: source }, source.replace(/^https?:\/\//, '').split('/')[0]))) : null)
}

function ExperienceTimeline({ project }) {
  if (project.experience.events.length === 0) {
    return h('section', { className: 'bt-teamov-experience' },
      h('div', { className: 'bt-teamov-board-head' }, h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Timeline')), h('h4', null, t('Project record')))),
      h('div', { className: 'bt-teamov-quiet-block' }, h(ClockIcon), h('span', null, t('No project changes recorded yet'))))
  }
  const events = project.experience.events.map((event, index) => {
    const reason = event.reason && event.reason !== event.text ? event.reason : ''
    const evidence = event.evidence && event.evidence !== event.text ? event.evidence : ''
    const progress = eventProgressText(event)
    const files = event.files?.length > 0
      ? `${event.files.slice(0, 6).join(' · ')}${event.files.length > 6 ? ` · ${t('and {count} more', { count: event.files.length - 6 })}` : ''}`
      : ''
    const detail = h('div', { className: 'bt-teamov-timeline-detail' },
      reason ? h('p', null, h('b', null, t('Reason')), reason) : null,
      progress ? h('p', null, h('b', null, t('Progress')), progress) : null,
      files ? h('p', { className: 'bt-teamov-timeline-files' }, h('b', null, t('Files')), files) : null,
      evidence ? h('p', null, h('b', null, t('Evidence')), evidence) : null,
      event.text && event.text !== reason && event.text !== evidence ? h('p', null, h('b', null, t('Recorded')), event.text) : null,
      h('p', { className: 'bt-teamov-timeline-source' }, h('b', null, t('Source')), `${event.source || eventActionWord(event)} · ${eventOriginWord(event)}`))
    return h('details', { key: `${event.kind}:${event.at}:${index}`, className: 'bt-teamov-timeline-event', 'data-kind': event.kind, 'data-action': event.action || undefined, 'data-source': event.sourceKind || undefined },
      h('summary', null,
        h('i', { 'aria-hidden': true }),
        h('time', null, relativeShort(event.at)),
        h('span', null, h('b', null, eventActionWord(event)), eventTitle(event) ? h('small', null, eventTitle(event)) : null)),
      detail)
  })
  return h('section', { className: 'bt-teamov-experience' },
    h('div', { className: 'bt-teamov-board-head' }, h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Timeline')), h('h4', null, t('Project record'))),
      h('span', { className: 'bt-teamov-count' }, project.changes.count)),
    h('div', { className: 'bt-teamov-timeline' }, events))
}

function StandardsLibrary({ data }) {
  if (data.standardsLibrary.length === 0) return null
  return h('section', { className: 'bt-teamov-standards-library' },
    h('div', { className: 'bt-teamov-view-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Standards library')), h('h3', null, t('Rules accumulated by project type'))),
      h('span', { className: 'bt-teamov-count' }, data.standardsLibrary.length)),
    h('div', { className: 'bt-teamov-standards-library-grid' }, data.standardsLibrary.map(profile =>
      h('div', { key: profile.id, className: 'bt-teamov-profile-card', 'data-profile': profile.id },
        h('span', { className: 'bt-teamov-profile-icon' }, h(InfoIcon)),
        h('span', { className: 'bt-teamov-profile-copy' }, h('b', null, profileWord(profile.id)), h('small', null, t('{count} projects', { count: profile.projects }))),
        h('span', { className: 'bt-teamov-profile-stats' },
          h('span', null, h('b', null, profile.files), h('small', null, t('Adopted files'))),
          h('span', null, h('b', null, profile.sources), h('small', null, t('Sources'))),
          h('span', null, h('b', null, profile.rules), h('small', null, t('Rules'))),
          h('span', null, h('b', null, profile.skills), h('small', null, t('Skills'))))))))
}

function ProjectCard({ project, expanded, toggle, openEntry, actions }) {
  const status = project.state
  const details = expanded ? h('div', { className: 'bt-teamov-project-body' },
    h(CompletionBoard, { project }),
    h(WorkItemsBoard, { project, actions }),
    h(StandardsDossier, { project }),
    h('div', { className: 'bt-teamov-project-insights' },
      h(KnowledgeBoard, { project }),
      h(ExperienceTimeline, { project })),
    h('div', { className: 'bt-teamov-project-actions' },
      project.target ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => openEntry(project.target) }, t('Open project'), h(ChevronRightIcon)) : null,
      project.target ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.openMemoryFromOverview(project.target.id) }, h(MemoryIcon), t('Open memory')) : null)) : null
  return h('article', { className: 'bt-teamov-project', 'data-state': status.state, 'data-expanded': expanded || undefined },
    h('button', { type: 'button', className: 'bt-teamov-project-head', 'aria-expanded': expanded, onClick: toggle },
      h('span', { className: 'bt-teamov-project-icon' }, h(FolderIcon)),
      h('span', { className: 'bt-teamov-project-title' },
        h('b', null, projectName(project), project.color ? h('i', { className: 'bt-teamov-project-color', style: { background: project.color } }) : null),
        h('small', null, `${profileWord(project.standards.profile?.id)} · ${project.folders.length > 0 ? project.folders.map(shortPath).join(t(', ')) : t('No working folder')}`)),
      h('span', { className: 'bt-teamov-project-side' },
        h('span', { className: 'bt-teamov-project-state' }, h(StateDot, { state: status.state }), completionWord(project.completion.status)),
        h(ChevronDownIcon))),
    h('div', { className: 'bt-teamov-project-progress' }, h(ProjectRail, { project })),
    details)
}

function ProjectView({ model, data, insights, busy, failed, openEntry, actions, adding, setAdding, expanded, setExpanded }) {
  const [draft, setDraft] = useState('')
  const submit = async event => {
    event.preventDefault()
    const name = draft.trim()
    if (name === '') return
    await actions.saveSection({ name })
    setDraft('')
    setAdding(false)
  }
  return h('div', { className: 'bt-teamov-body', id: 'bt-teamov-projects', role: 'tabpanel' },
    h('div', { className: 'bt-teamov-view-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Projects')), h('h3', null, t('What the team is building'))),
      h('div', { className: 'bt-teamov-view-actions' },
        h('span', { className: 'bt-teamov-auto-note' }, h('i'), t('Auto refresh 15s')),
        adding ? null : h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setAdding(true) }, h(PlusIcon), t('Add project')))),
    adding ? h('form', { className: 'bt-teamov-add-project', onSubmit: submit },
      h('input', { autoFocus: true, maxLength: 32, value: draft, placeholder: t('Project name'), 'aria-label': t('Project name'), onChange: event => setDraft(event.target.value), onKeyDown: event => { if (event.key === 'Escape') { event.preventDefault(); setAdding(false) } } }),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm', disabled: draft.trim() === '' }, t('Create')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setAdding(false) }, t('Cancel'))) : null,
    insightErrorView(insights, busy, failed),
    data.projects.length === 0 ? h(ProjectEmpty) : h('div', { className: 'bt-teamov-projects' }, data.projects.map(project =>
      h(ProjectCard, { key: project.id, project, expanded: expanded === project.id, toggle: () => setExpanded(expanded === project.id ? null : project.id), openEntry, actions }))),
    h(StandardsLibrary, { data }),
    h(MemoryLibrary, { insights, model, openMemory: actions.openMemoryFromOverview }),
    h('div', { className: 'bt-teamov-refreshed' }, h(ClockIcon), insights?.at ? t('Updated {time}', { time: relativeShort(insights.at) }) : t('Waiting for a scan')),
  )
}

function ProjectEmpty() {
  return h('div', { className: 'bt-teamov-empty inline' }, h(FolderIcon), h('b', null, t('No projects yet')), h('span', null, t('Add a project to group its Bots, conversations, memory and standards.')))
}

function MemoryLibrary({ insights, model, openMemory }) {
  const memory = insights?.memory
  if (memory === undefined) return null
  const mainBot = model.bots[0]?.bot
  const recent = [
    ...Object.entries(memory.owners ?? {}).flatMap(([id, owner]) => (owner.recent ?? []).map(entry => ({ ...entry, id, owner }))),
    ...(memory.team?.recent ?? []).map(entry => ({ ...entry, id: mainBot?.id, owner: memory.team, team: true })),
  ].filter(entry => entry.id).sort((a, b) => String(b.added ?? '').localeCompare(String(a.added ?? ''))).slice(0, 6)
  const topics = [...new Set([...(memory.team?.topics ?? []), ...Object.values(memory.owners ?? {}).flatMap(owner => owner.topics ?? [])])].slice(0, 12)
  return h('section', { className: 'bt-teamov-memory-library' },
    h('div', { className: 'bt-teamov-view-head' },
      h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Memory library')), h('h3', null, t('What the team has learned'))),
      h('span', { className: 'bt-teamov-count' }, memory.total)),
    h('div', { className: 'bt-teamov-memory-topics' }, topics.length === 0 ? h('span', { className: 'bt-teamov-quiet' }, t('No topics yet')) : topics.map(topic => h('span', { key: topic }, topic))),
    h('div', { className: 'bt-teamov-list' }, recent.map((entry, index) => {
      const owner = ownerOf(model, entry.id)
      return h('button', { key: `${entry.id}:${index}`, type: 'button', className: 'bt-teamov-memory-row', onClick: () => owner ? openMemory(entry.id) : null },
        h('span', { className: 'bt-teamov-memory-row-icon' }, h(MemoryIcon)),
        h('span', { className: 'bt-teamov-row-text' }, h('b', null, entry.team ? t('Team memory') : owner?.name ?? t('Memory')), h('small', null, entry.text)),
        entry.topic ? h('span', { className: 'bt-teamov-memory-topic' }, entry.topic) : null)
    })))
}

function AgentCard({ row, openEntry, openMemory }) {
  const bot = row.bot
  const health = row.health === 'blocked' ? t('Blocked') : stateWord(row.health)
  const open = () => {
    if (row.kind === 'dsh') { if (row.sessionId) openEntry({ id: row.sessionId }) }
    else openEntry(bot)
  }
  const reviewed = row.learning.total
  const approved = row.learning.approved
  const pending = row.learning.pending
  return h('article', { className: 'bt-teamov-agent', 'data-health': row.health },
    h('div', { className: 'bt-teamov-agent-head' },
      row.kind === 'dsh'
        ? h('span', { className: 'bt-teamov-agent-glyph' }, h(GaugeIcon))
        : h(BotAvatar, { bot, size: 38, state: row.health === 'blocked' ? 'alert' : row.row.state }),
      h('span', { className: 'bt-teamov-agent-title' }, h('b', null, row.name, h(StateDot, { state: row.health === 'blocked' ? 'alert' : row.health })), h('small', null, [row.role, row.engine ?? row.model].filter(Boolean).join(' · ') || t('Agent'))),
      h('button', { type: 'button', className: 'bt-round bt-round-sm', disabled: row.kind === 'dsh' ? !row.sessionId : false, 'aria-label': t('Open {name}', { name: row.name }), onClick: open }, h(ChevronRightIcon))),
    h('div', { className: 'bt-teamov-agent-grid' },
      h('div', { className: 'bt-teamov-agent-metric' }, h('span', { className: 'bt-teamov-mini-kicker' }, h(GaugeIcon), t('Health')), h('b', null, health), h('small', null, row.row.running ? t('Live work is running') : t('Current runtime state'))),
      h('div', { className: 'bt-teamov-agent-metric' }, h('span', { className: 'bt-teamov-mini-kicker' }, h(MemoryIcon), t('Self-improvement')),
        h('div', { className: 'bt-teamov-learning-bar', role: 'img', 'aria-label': t('{approved} approved, {declined} declined, {pending} pending', { approved, declined: row.learning.declined, pending }) },
          h('i', { className: 'approved', style: { flex: approved } }), h('i', { className: 'declined', style: { flex: row.learning.declined } }), h('i', { className: 'pending', style: { flex: pending } }), reviewed + pending === 0 ? h('i', { className: 'empty' }) : null),
        h('small', null, reviewed + pending === 0 ? t('No review history') : t('{approved} approved · {pending} pending', { approved, pending }))),
      h('div', { className: 'bt-teamov-agent-metric wide' }, h('span', { className: 'bt-teamov-mini-kicker' }, h(TerminalIcon), t('Standards evidence')), h(EvidenceStrip, { evidence: row.evidence, compact: true }),
        h('small', null, t('{count} of 4 evidence points found', { count: row.evidenceCount })),
        h('small', { 'data-quality': row.standards.quality ? 'recorded' : 'none' }, row.standards.quality ? t('Recorded checks: {passed} of {expected} passed', { passed: row.standards.quality.passed, expected: row.standards.quality.expected }) : t('No recorded check run')),
        h('div', { className: 'bt-teamov-check-row' }, row.standards.checks.slice(0, 4).map(check => h('span', { key: check.name }, check.name))))),
    h('div', { className: 'bt-teamov-agent-foot' },
      h('span', null, h(MemoryIcon), row.memory.count > 0 ? t('{count} memories · {topics} topics', { count: row.memory.count, topics: row.memory.topics.length }) : t('No memories saved')),
      row.kind === 'bot' ? h('button', { type: 'button', className: 'bt-teamov-link', onClick: () => openMemory(row.id) }, t('Memory')) : null,
      row.folder ? h('span', { className: 'bt-teamov-folder' }, `${profileWord(row.standards.profile?.id)} · ${shortPath(row.folder)}`) : null))
}

function AgentView({ data, openEntry, openMemory, insights, busy, failed }) {
  return h('div', { className: 'bt-teamov-body', id: 'bt-teamov-agents', role: 'tabpanel' },
    h('div', { className: 'bt-teamov-view-head' }, h('div', null, h('span', { className: 'bt-teamov-kicker' }, t('Agents')), h('h3', null, t('Health and self-improvement'))),
      h('div', { className: 'bt-teamov-view-actions' },
        h('span', { className: 'bt-teamov-auto-note' }, h('i', { 'data-live': data.counts.working > 0 || undefined }), t('Auto refresh 15s')),
        h('span', { className: 'bt-teamov-live-note' }, data.counts.working > 0 ? t('Live') : t('Quiet')))),
    insightErrorView(insights, busy, failed),
    h('div', { className: 'bt-teamov-agents' }, data.rows.map(row => h(AgentCard, { key: `${row.kind}:${row.id}`, row, openEntry, openMemory }))),
    h('div', { className: 'bt-teamov-refreshed' }, h(ClockIcon), insights?.at ? t('Updated {time}', { time: relativeShort(insights.at) }) : t('Waiting for a scan')))
}

function insightErrorView(insights, busy, failed = false) {
  if (!failed && insights !== null) return null
  return h('div', { className: 'bt-teamov-insight-state', role: failed ? 'alert' : 'status' },
    h('span', null, failed ? t('Could not read project evidence') : busy ? t('Reading memory and project files…') : t('Project evidence is unavailable')))
}

export function TeamOverviewPanel({ useRoster, useWork, useSessionStatus, useUi, actions, leaving = false }) {
  const roster = useRoster(value => value)
  const work = useWork(value => value)
  const sessionStatus = useSessionStatus(value => value)
  const bootFailed = useUi(value => value.bootFailed === true)
  const model = useMemo(() => overviewModel(roster, work, sessionStatus), [roster, work, sessionStatus])
  const [tab, setTab] = useState('team')
  const [insights, setInsights] = useState(null)
  const [insightBusy, setInsightBusy] = useState(false)
  const [insightFailed, setInsightFailed] = useState(false)
  const [sites, setSites] = useState(null)
  const [siteBusy, setSiteBusy] = useState(false)
  const [siteFailed, setSiteFailed] = useState(false)
  const [addingProject, setAddingProject] = useState(false)
  const [expandedProject, setExpandedProject] = useState(null)
  const panel = useRef(null)
  const restoreFocus = useRef(true)
  const request = useRef(0)
  const siteRequest = useRef(0)
  const projects = useMemo(() => projectModel(model, insights), [model, insights])
  const agents = useMemo(() => agentBoardModel(model, insights), [model, insights])
  const loadInsights = useCallback(async (fresh = false) => {
    if (actions.teamOverviewInsights === undefined) return
    const current = ++request.current
    setInsightBusy(true)
    try {
      const value = await actions.teamOverviewInsights(fresh)
      if (request.current !== current) return
      setInsights(value)
      setInsightFailed(false)
    } catch {
      if (request.current === current) setInsightFailed(true)
    } finally {
      if (request.current === current) setInsightBusy(false)
    }
  }, [actions])
  const loadSites = useCallback(async () => {
    if (actions.sites === undefined) return
    const current = ++siteRequest.current
    setSiteBusy(true)
    try {
      const value = await actions.sites()
      if (siteRequest.current !== current) return
      setSites(value)
      setSiteFailed(false)
    } catch {
      if (siteRequest.current === current) setSiteFailed(true)
    } finally {
      if (siteRequest.current === current) setSiteBusy(false)
    }
  }, [actions])
  useEffect(() => {
    if (!roster.ready) return undefined
    void loadInsights(false)
    return undefined
  }, [roster.ready, roster.revision, loadInsights])
  useEffect(() => {
    if (!roster.ready || (tab !== 'projects' && tab !== 'agents')) return undefined
    const timer = setInterval(() => { void loadInsights(false) }, 15_000)
    return () => clearInterval(timer)
  }, [roster.ready, tab, loadInsights])
  useEffect(() => {
    if (!roster.ready || tab !== 'sites') return undefined
    void loadSites()
    const timer = setInterval(() => { void loadSites() }, 15_000)
    return () => clearInterval(timer)
  }, [roster.ready, tab, loadSites])
  useEffect(() => {
    const previous = document.activeElement
    const onKey = event => {
      if (event.key === 'Escape') { actions.closeTeamOverview(); return }
      if (event.key !== 'Tab') return
      const focusable = [...(panel.current?.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])]
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (!restoreFocus.current) return
      setTimeout(() => {
        if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
        else document.querySelector('.bt-teamov-tab')?.focus()
      }, 0)
    }
  }, [actions])
  const openEntry = entry => {
    if (entry === undefined || entry === null) return
    restoreFocus.current = false
    actions.closeTeamOverview()
    actions.openSession(entry.id)
  }
  const openMemory = id => {
    restoreFocus.current = false
    actions.openMemoryFromOverview(id)
  }
  const teamBody = model.counts.bots === 0 && model.counts.groups === 0
    ? h(EmptyState)
    : h('div', { className: 'bt-teamov-body', id: 'bt-teamov-team', role: 'tabpanel' },
      h(Attention, { model, openEntry }),
      h(Activity, { model, openEntry }),
      h(TeamSections, { model, openEntry }),
      h(Recent, { model, openEntry }),
      h(Learning, { model, openEntry }))
  return h('div', { className: 'bt-teamov-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-teamov-scrim', onMouseDown: actions.closeTeamOverview }),
    h('section', { ref: panel, className: 'bt-teamov', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'bt-teamov-title', 'data-leaving': leaving || undefined, onMouseDown: event => event.stopPropagation() },
      h('header', { className: 'bt-teamov-top' },
        h('div', null, h('span', { className: 'bt-teamov-eyebrow' }, t('Team workspace')), h('h2', { id: 'bt-teamov-title' }, t('Team overview'))),
        h('button', { type: 'button', className: 'bt-round', autoFocus: true, 'aria-label': t('Close team overview'), title: t('Close'), onClick: actions.closeTeamOverview }, h(CloseIcon))),
      !roster.ready ? (bootFailed ? h(BootError) : h(Skeleton)) : h(Fragment, null,
        tab === 'team' ? h(Summary, { counts: model.counts })
          : tab === 'projects' ? h(ProjectSummary, { counts: projects.counts })
            : tab === 'agents' ? h(AgentSummary, { counts: agents.counts })
              : h(SiteSummary, { counts: (sites ?? EMPTY_SITE_DIRECTORY).counts }),
        h(DataTabs, {
          tab, setTab, model, projectCount: projects.counts.total, agentCount: agents.counts.total, siteCount: (sites ?? EMPTY_SITE_DIRECTORY).counts.total,
          busy: tab === 'sites' ? siteBusy : insightBusy,
          refresh: () => void (tab === 'sites' ? loadSites() : loadInsights(true)),
        }),
        tab === 'team' ? teamBody
          : tab === 'projects' ? h(ProjectView, {
            model, data: projects, insights, busy: insightBusy, failed: insightFailed, openEntry, actions,
            adding: addingProject, setAdding: setAddingProject, expanded: expandedProject, setExpanded: setExpandedProject,
          })
            : tab === 'agents' ? h(AgentView, { data: agents, openEntry, openMemory, insights, busy: insightBusy, failed: insightFailed })
              : h(SitesView, {
                data: sites ?? EMPTY_SITE_DIRECTORY, loading: siteBusy, failed: siteFailed, busy: siteBusy, actions,
                paths: [...new Set(projects.projects.flatMap(project => project.folders))], onData: setSites,
              })))
  )
}

export function TeamOverviewTab({ useUi, useSurface, actions }) {
  const open = useUi(value => value.teamOverview === true)
  const mode = useSurface(value => value.mode)
  const occupied = useUi(value => value.details !== null || value.settings !== null || value.newChat !== null || value.exchange !== null || value.memory !== null)
  if (open || occupied || mode !== 'bot') return null
  return h('button', { type: 'button', className: 'bt-teamov-tab', title: t('Open team overview'), 'aria-label': t('Open team overview'), onClick: actions.openTeamOverview },
    h(PeopleIcon), h('span', null, t('Team overview')))
}

export const TEAM_OVERVIEW_CSS = `
.bt-teamov-tab{position:fixed;z-index:29;right:0;top:44%;display:flex;flex-direction:column;align-items:center;gap:6px;width:30px;min-height:104px;padding:9px 0;border:.5px solid var(--bt-line-2);border-right:0;border-radius:10px 0 0 10px;background:var(--bt-glass-bg);color:var(--bt-ink-3);box-shadow:var(--bt-glass-shadow);-webkit-backdrop-filter:blur(20px) saturate(180%);backdrop-filter:blur(20px) saturate(180%);font-family:var(--bt-font);cursor:pointer;transition:width .16s ease,color .12s ease,background-color .12s ease}
.bt-teamov-tab:hover{width:34px;color:var(--bt-ink);background:var(--bt-card)}
/* The board is the team's one entry on that edge: its header carries the overview, and
   its collapsed tab carries the counts. Two rails side by side was the noise. */
body:has(.tbh) .bt-teamov-tab,body:has(.tbh-toggle) .bt-teamov-tab{display:none}
.bt-teamov-tab svg{flex:none;width:14px;height:14px}
.bt-teamov-tab span{writing-mode:vertical-rl;font-size:9px;line-height:14px;letter-spacing:.08em}
.bt-teamov-tab:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-teamov-layer{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:var(--bt-font);color:var(--bt-ink)}
.bt-teamov-scrim{position:absolute;inset:0;background:rgba(0,0,0,.3);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);animation:bt-veil-in .18s ease-out}
.bt-teamov{position:relative;z-index:1;width:min(1220px,calc(100vw - 48px));height:min(900px,calc(100vh - 48px));max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--bt-main);border:.5px solid var(--bt-line-2);border-radius:20px;box-shadow:0 28px 90px -30px rgba(0,0,0,.48);overflow:hidden;animation:bt-teamov-in ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing}}
@keyframes bt-teamov-in{from{transform:translateY(10px) scale(.985);opacity:0}}
.bt-teamov-layer[data-leaving]{pointer-events:none}
.bt-teamov-layer[data-leaving] .bt-teamov-scrim{animation:bt-teamov-veil-out .16s ease-in forwards}
.bt-teamov[data-leaving]{animation:bt-teamov-out .16s cubic-bezier(.4,0,1,1) forwards}
@keyframes bt-teamov-out{to{transform:translateY(8px) scale(.99);opacity:0}}
@keyframes bt-teamov-veil-out{to{opacity:0}}
.bt-teamov-top{height:76px;flex:none;padding:16px 18px 12px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--bt-line)}
.bt-teamov-eyebrow{display:block;color:var(--bt-ink-3);font-size:10px;line-height:15px;letter-spacing:.1em;text-transform:uppercase}
.bt-teamov-top h2{margin:2px 0 0;font-size:20px;line-height:26px;font-weight:600;letter-spacing:-.015em}
.bt-teamov-summary{flex:none;min-height:82px;padding:11px 20px;display:grid;grid-template-columns:58px minmax(0,1fr);gap:15px;align-items:center;border-bottom:1px solid var(--bt-line)}
.bt-teamov-ring{position:relative;width:58px;height:58px;padding:1px;display:grid;place-items:center;border-radius:50%;corner-shape:round;background:var(--bt-teamov-ring);animation:bt-teamov-ring-in .4s cubic-bezier(.22,1,.36,1) both}
.bt-teamov-ring::before{content:"";position:absolute;inset:7px;border-radius:50%;corner-shape:round;background:var(--bt-main);box-shadow:inset 0 0 0 .5px var(--bt-line)}
.bt-teamov-ring>span{position:relative;z-index:1;display:flex;flex-direction:column;align-items:center;gap:0}
.bt-teamov-ring b{font-size:15px;line-height:17px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-ring small{color:var(--bt-ink-3);font-size:8px;line-height:11px}
.bt-teamov-stats{min-width:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.bt-teamov-stat{min-width:0;padding:0 12px;display:flex;flex-direction:column;gap:2px;border-left:1px solid var(--bt-line)}
.bt-teamov-stat:first-child{padding-left:0;border-left:0}
.bt-teamov-stat b{font-size:20px;line-height:24px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-stat small{display:flex;align-items:center;gap:4px;color:var(--bt-ink-3);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-stat small::before{content:"";width:4px;height:4px;flex:none;border-radius:50%;background:var(--bt-line-2)}
.bt-teamov-stat[data-kind=working] b{color:var(--bt-green)}
.bt-teamov-stat[data-kind=working] small::before{background:var(--bt-green)}
.bt-teamov-stat[data-kind=needs] b{color:var(--bt-accent)}
.bt-teamov-stat[data-kind=needs] small::before{background:var(--bt-accent)}
.bt-teamov-stat[data-kind=teammates] b{color:var(--bt-star)}
.bt-teamov-stat[data-kind=teammates] small::before{background:var(--bt-star)}
.bt-teamov-stat[data-kind=unread] b{color:var(--bt-accent)}
.bt-teamov-stat[data-kind=unread] small::before{background:var(--bt-accent)}
@keyframes bt-teamov-ring-in{from{opacity:0;transform:rotate(-18deg) scale(.82)}}
.bt-teamov-body{flex:1;min-height:0;overflow:auto;padding:4px 20px 28px;scrollbar-width:thin}
.bt-teamov-section{padding:17px 0 3px;border-bottom:1px solid var(--bt-line)}
.bt-teamov-section:last-child{border-bottom:0}
.bt-teamov-head{min-height:31px;margin-bottom:8px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bt-teamov-head h3{margin:2px 0 0;font-size:14px;line-height:19px;font-weight:600}
.bt-teamov-kicker{display:block;color:var(--bt-ink-3);font-size:9px;line-height:13px;letter-spacing:.09em;text-transform:uppercase}
.bt-teamov-count{min-width:20px;height:20px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:11px;font-variant-numeric:tabular-nums}
.bt-teamov-list{display:flex;flex-direction:column;gap:2px;margin:0 -8px}
.bt-teamov-row,.bt-teamov-attention,.bt-teamov-record{width:100%;min-height:48px;padding:6px 8px;display:flex;align-items:center;gap:10px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink);text-align:left;cursor:pointer;transition:background-color .12s ease}
.bt-teamov-live-row{position:relative}
.bt-teamov-live-row::before{content:"";position:absolute;left:1px;top:19px;width:3px;height:3px;border-radius:50%;background:var(--bt-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-green) 12%,transparent);animation:bt-teamov-live 1.8s ease-in-out infinite}
.bt-teamov-activity-avatar{display:inline-flex;flex:none;border-radius:50%;box-shadow:0 0 0 1px color-mix(in srgb,var(--bt-green) 20%,transparent)}
@keyframes bt-teamov-live{0%,100%{opacity:.5;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.bt-teamov-row:hover,.bt-teamov-attention:hover,.bt-teamov-record:hover{background:var(--bt-hover)}
.bt-teamov-row:focus-visible,.bt-teamov-attention:focus-visible,.bt-teamov-record:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-teamov-row-text{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.bt-teamov-row-text>b{min-width:0;color:var(--bt-ink);font-size:13px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-row-text>small{min-width:0;color:var(--bt-ink-3);font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-row>svg,.bt-teamov-attention>svg,.bt-teamov-record>svg{flex:none;color:var(--bt-ink-3)}
.bt-teamov-context{color:var(--bt-ink-3);font-weight:400}
.bt-teamov-age{flex:none;color:var(--bt-ink-3);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-teamov-state-dot{width:6px;height:6px;margin-left:6px;display:inline-block;border-radius:50%;corner-shape:round;background:var(--bt-ink-3);vertical-align:1px}
.bt-teamov-state-dot[data-state=working],.bt-teamov-state-dot[data-state=thinking],.bt-teamov-state-dot[data-state=searching],.bt-teamov-state-dot[data-state=sending]{background:var(--bt-green);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-green) 20%,transparent)}
.bt-teamov-state-dot[data-state=alert]{background:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 20%,transparent)}
.bt-teamov-state-dot[data-state=waiting]{background:transparent;border:1px solid var(--bt-ink-3)}
.bt-teamov-state-dot[data-state=unread]{background:var(--bt-accent)}
.bt-teamov-attention{background:color-mix(in srgb,var(--bt-star) 4%,transparent)}
.bt-teamov-attention:hover{background:color-mix(in srgb,var(--bt-star) 8%,var(--bt-hover))}
.bt-teamov-attention-icon{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-attention-icon svg{width:15px;height:15px}
.bt-teamov-group{padding:7px 0 3px}
.bt-teamov-group+.bt-teamov-group{border-top:1px solid var(--bt-line)}
.bt-teamov-group-head{min-height:25px;padding:0 8px;display:flex;align-items:center;justify-content:space-between;color:var(--bt-ink-2)}
.bt-teamov-group-head b{font-size:11px;line-height:16px;font-weight:600}
.bt-teamov-group-tail{display:inline-flex;align-items:center;gap:7px}
.bt-teamov-group-count{color:var(--bt-ink-3);font-size:10px}
.bt-teamov-mini-pulse{display:inline-flex;align-items:center;gap:2px}
.bt-teamov-mini-pulse i{width:4px;height:4px;border-radius:50%;background:var(--bt-line-2)}
.bt-teamov-mini-pulse i[data-state=working],.bt-teamov-mini-pulse i[data-state=thinking],.bt-teamov-mini-pulse i[data-state=searching],.bt-teamov-mini-pulse i[data-state=sending]{background:var(--bt-green)}
.bt-teamov-mini-pulse i[data-state=alert]{background:var(--bt-accent)}
.bt-teamov-mini-pulse i[data-state=waiting]{background:var(--bt-star)}
.bt-teamov-mini-pulse i[data-state=unread]{background:color-mix(in srgb,var(--bt-accent) 58%,var(--bt-line-2))}
.bt-teamov-record{min-height:44px;display:grid;grid-template-columns:7px 44px minmax(0,1fr) 14px;gap:7px}
.bt-teamov-record-dot{width:6px;height:6px;align-self:center;border-radius:50%;background:var(--bt-line-2)}
.bt-teamov-record-dot[data-state=working],.bt-teamov-record-dot[data-state=thinking],.bt-teamov-record-dot[data-state=searching],.bt-teamov-record-dot[data-state=sending]{background:var(--bt-green)}
.bt-teamov-record-dot[data-state=alert],.bt-teamov-record-dot[data-state=needs],.bt-teamov-record-dot[data-state=unread]{background:var(--bt-accent)}
.bt-teamov-record-dot[data-state=waiting]{background:var(--bt-star)}
.bt-teamov-record-time{color:var(--bt-ink-3);font-size:10px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-teamov-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:70px 24px;text-align:center;color:var(--bt-ink-3)}
.bt-teamov-empty>svg{width:30px;height:30px;opacity:.5}
.bt-teamov-empty b{font-size:14px;line-height:20px;color:var(--bt-ink)}
.bt-teamov-empty span{max-width:360px;font-size:11px;line-height:17px}
.bt-teamov-skeleton{flex:1;padding:24px 20px;display:flex;flex-direction:column;gap:12px}
.bt-teamov-skeleton i{display:block;border-radius:10px;background:linear-gradient(90deg,var(--bt-hover),var(--bt-active),var(--bt-hover));background-size:200% 100%;animation:bt-us-shine 1.4s ease-in-out infinite}
.bt-teamov-skel-title{width:260px;height:26px}
.bt-teamov-skel-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:8px 0}
.bt-teamov-skel-stats i{height:48px}
.bt-teamov-skel-line{height:52px}
.bt-teamov-skel-line.short{width:75%}
.bt-teamov-databar{flex:none;min-height:46px;padding:6px 14px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--bt-line);background:color-mix(in srgb,var(--bt-main) 94%,var(--bt-hover))}
.bt-teamov-tabs{min-width:0;display:flex;align-items:center;gap:2px}
.bt-teamov-tabitem{height:32px;padding:0 10px;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:12px;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.bt-teamov-tabitem:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-teamov-tabitem[aria-selected=true]{background:var(--bt-active);color:var(--bt-ink)}
.bt-teamov-tabitem svg{width:14px;height:14px}
.bt-teamov-tabitem i{min-width:17px;height:17px;padding:0 5px;display:inline-flex;align-items:center;justify-content:center;border-radius:999px;background:color-mix(in srgb,var(--bt-ink) 7%,transparent);color:var(--bt-ink-3);font-size:9px;font-style:normal;font-variant-numeric:tabular-nums}
.bt-teamov-tabitem[aria-selected=true] i{background:var(--bt-main);color:var(--bt-ink-2)}
.bt-teamov-tabitem:focus-visible,.bt-teamov-refresh:focus-visible,.bt-teamov-project-head:focus-visible,.bt-teamov-link:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-teamov-refresh{flex:none;height:30px;padding:0 9px;display:inline-flex;align-items:center;gap:6px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:11px;cursor:pointer}
.bt-teamov-refresh:hover:not(:disabled){background:var(--bt-hover);color:var(--bt-ink)}
.bt-teamov-refresh:disabled{opacity:.55;cursor:default}
.bt-teamov-refresh svg{width:14px;height:14px}
.bt-teamov-refresh:disabled svg{animation:bt-teamov-spin 1s linear infinite}
@keyframes bt-teamov-spin{to{transform:rotate(360deg)}}
.bt-teamov-portfolio{flex:none;min-height:76px;padding:12px 20px;display:grid;grid-template-columns:42px minmax(150px,.8fr) minmax(0,1.5fr);gap:12px;align-items:center;border-bottom:1px solid var(--bt-line)}
.bt-teamov-portfolio-mark{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-portfolio-mark svg{width:20px;height:20px}
.bt-teamov-portfolio-copy{min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-teamov-portfolio-copy b{font-size:14px;line-height:19px;font-weight:600}
.bt-teamov-portfolio-copy span{color:var(--bt-ink-3);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-portfolio-stats{min-width:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr))}
.bt-teamov-portfolio-stats>span{min-width:0;padding:0 9px;display:flex;flex-direction:column;gap:1px;border-left:1px solid var(--bt-line)}
.bt-teamov-portfolio-stats>span:first-child{padding-left:0;border-left:0}
.bt-teamov-portfolio-stats b{font-size:17px;line-height:21px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-portfolio-stats small{color:var(--bt-ink-3);font-size:9px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-portfolio-stats [data-kind=working] b{color:var(--bt-green)}
.bt-teamov-portfolio-stats [data-kind=needs] b{color:var(--bt-accent)}
.bt-teamov-portfolio-stats [data-kind=learning] b{color:var(--bt-star)}
.bt-teamov-view-head{min-height:52px;padding:10px 0 8px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bt-teamov-view-head h3{margin:2px 0 0;font-size:16px;line-height:21px;font-weight:600;letter-spacing:-.01em}
.bt-teamov-view-head .bt-soft{flex:none;margin-top:3px}
.bt-teamov-view-actions{display:flex;align-items:center;gap:8px}
.bt-teamov-auto-note{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-3);font-size:9px;white-space:nowrap}
.bt-teamov-auto-note i{width:5px;height:5px;border-radius:50%;background:var(--bt-ink-3)}
.bt-teamov-auto-note i[data-live]{background:var(--bt-green)}
.bt-teamov-add-project{margin:2px 0 10px;padding:9px;display:flex;align-items:center;gap:7px;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-add-project input{min-width:0;flex:1;height:32px;padding:0 10px;border:0;border-radius:8px;background:var(--bt-hover);color:var(--bt-ink);font:inherit;font-size:12px;outline:none}
.bt-teamov-add-project input:focus{box-shadow:0 0 0 2px var(--bt-accent)}
.bt-teamov-insight-state{min-height:0;padding:0 0 8px;color:var(--bt-ink-3);font-size:10px;line-height:15px}
.bt-teamov-insight-state:empty{display:none}
.bt-teamov-projects{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:start}.bt-teamov-project[data-expanded]{grid-column:1/-1}
.bt-teamov-project{border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line),0 6px 20px -18px rgba(0,0,0,.35);overflow:hidden;transition:background-color .14s ease,box-shadow .14s ease}
.bt-teamov-project:hover{box-shadow:inset 0 0 0 1px var(--bt-line-2),0 9px 26px -18px rgba(0,0,0,.38)}
.bt-teamov-project-head{width:100%;min-height:62px;padding:10px 12px;display:flex;align-items:center;gap:10px;border:0;background:transparent;color:var(--bt-ink);text-align:left;font:inherit;cursor:pointer}
.bt-teamov-project-head:hover{background:color-mix(in srgb,var(--bt-hover) 62%,transparent)}
.bt-teamov-project-icon{width:36px;height:36px;flex:none;display:grid;place-items:center;border-radius:12px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-project-icon svg{width:17px;height:17px}
.bt-teamov-project-title{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.bt-teamov-project-title>b{min-width:0;display:flex;align-items:center;gap:6px;font-size:14px;line-height:19px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-project-title>small{min-width:0;color:var(--bt-ink-3);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-project-color{width:6px;height:6px;flex:none;border-radius:50%;corner-shape:round}
.bt-teamov-project-side{flex:none;display:flex;align-items:center;gap:8px;color:var(--bt-ink-3)}
.bt-teamov-project-side>svg{width:14px;height:14px;transition:transform .18s ease}
.bt-teamov-project-head[aria-expanded=true] .bt-teamov-project-side>svg{transform:rotate(180deg)}
.bt-teamov-project-state{display:inline-flex;align-items:center;gap:3px;font-size:10px;white-space:nowrap}
.bt-teamov-project-progress{padding:0 12px 10px 58px}
.bt-teamov-project-rail{display:flex;flex-direction:column;gap:4px}
.bt-teamov-rail-row{min-height:20px;display:grid;grid-template-columns:58px minmax(0,1fr) 38px;align-items:center;gap:7px}
.bt-teamov-rail-row>span{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-3);font-size:9px;line-height:13px}
.bt-teamov-rail-row>span svg{width:11px;height:11px}
.bt-teamov-rail-row>small{min-width:0;color:var(--bt-ink-3);font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-rail-row>b{color:var(--bt-ink-3);font-size:9px;font-weight:500;text-align:right;font-variant-numeric:tabular-nums}
.bt-teamov-flow-dots{min-width:0;display:flex;align-items:center;gap:3px;overflow:hidden}
.bt-teamov-flow-dots i{width:7px;height:7px;flex:none;border-radius:50%;background:var(--bt-line-2)}
.bt-teamov-flow-dots i[data-state=done],.bt-teamov-flow-dots i[data-state=working],.bt-teamov-flow-dots i[data-state=thinking],.bt-teamov-flow-dots i[data-state=searching],.bt-teamov-flow-dots i[data-state=sending]{background:var(--bt-green)}
.bt-teamov-flow-dots i[data-state=current]{background:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 12%,transparent)}
.bt-teamov-flow-dots i[data-state=alert],.bt-teamov-flow-dots i[data-state=needs]{background:var(--bt-accent)}
.bt-teamov-flow-dots i[data-state=waiting]{background:var(--bt-star)}
.bt-teamov-flow-dots i[data-state=unread]{background:color-mix(in srgb,var(--bt-accent) 58%,var(--bt-line-2))}
.bt-teamov-evidence-dots{display:flex;align-items:center;gap:4px}
.bt-teamov-evidence-dots i{width:13px;height:4px;border-radius:999px;background:var(--bt-line-2)}
.bt-teamov-evidence-dots i[data-on]{background:var(--bt-green)}
.bt-teamov-project-body{padding:0 14px 14px;border-top:1px solid var(--bt-line)}
.bt-teamov-project-insights{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr);gap:10px;padding-top:10px}
.bt-teamov-board-head{min-height:28px;display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.bt-teamov-board-head h4{margin:2px 0 0;font-size:13px;line-height:18px;font-weight:600}
.bt-teamov-board-badge{height:20px;padding:0 7px;display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:8px}
.bt-teamov-board-badge i{width:5px;height:5px;border-radius:50%;background:var(--bt-green);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-green) 12%,transparent)}
.bt-teamov-board-badge[data-warning]{color:var(--bt-star);background:color-mix(in srgb,var(--bt-star) 10%,var(--bt-hover))}
.bt-teamov-completion,.bt-teamov-knowledge,.bt-teamov-experience{border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 2.6%,transparent);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-completion{padding:10px}
.bt-teamov-completion[data-status=failing]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-danger) 30%,var(--bt-line))}
.bt-teamov-completion[data-status=attention],.bt-teamov-completion[data-status=standards]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-accent) 28%,var(--bt-line))}
.bt-teamov-completion[data-status=verified],.bt-teamov-completion[data-status=complete]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-green) 28%,var(--bt-line))}
.bt-teamov-workitems{margin-top:10px;padding:10px;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 2.6%,transparent);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-workitems[data-state=stale]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-star) 28%,var(--bt-line))}
.bt-teamov-work-title{display:flex;flex-direction:column;gap:1px}
.bt-teamov-work-kicker{display:inline-flex;align-items:center;gap:4px}
.bt-teamov-work-kicker svg{width:10px;height:10px}
.bt-teamov-work-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:7px}
.bt-teamov-work-tabs,.bt-teamov-work-filters{display:flex;align-items:center;gap:3px}
.bt-teamov-work-tabs button,.bt-teamov-work-filters button{height:22px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-3);font:inherit;font-size:8px;cursor:pointer}
.bt-teamov-work-tabs button{display:inline-flex;align-items:center;gap:4px}
.bt-teamov-work-tabs button i{min-width:13px;height:13px;padding:0 3px;display:inline-grid;place-items:center;border-radius:999px;background:var(--bt-hover);font-style:normal;font-size:7px;font-variant-numeric:tabular-nums}
.bt-teamov-work-tabs button:hover,.bt-teamov-work-filters button:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-teamov-work-tabs button[data-active],.bt-teamov-work-filters button[data-active]{background:var(--bt-card);color:var(--bt-ink);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-work-list{margin-top:5px;border-top:1px solid var(--bt-line)}
.bt-teamov-work-row{min-height:40px;display:grid;grid-template-columns:44px minmax(0,1fr) auto 42px 13px;align-items:center;gap:7px;color:var(--bt-ink);text-decoration:none;border-top:1px solid var(--bt-line);transition:background-color .12s ease}
.bt-teamov-work-row:first-child{border-top:0}
.bt-teamov-work-row:hover{background:var(--bt-hover);border-radius:8px}
.bt-teamov-work-number{min-width:0;display:flex;flex-direction:column}
.bt-teamov-work-number b{font-size:9px;line-height:12px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-work-number small{color:var(--bt-ink-3);font-size:7px;line-height:9px;text-transform:uppercase}
.bt-teamov-work-copy{min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-teamov-work-copy>b{min-width:0;font-size:10px;line-height:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-work-copy>small{min-width:0;color:var(--bt-ink-3);font-size:8px;line-height:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-work-signals{display:flex;align-items:center;gap:4px}
.bt-teamov-work-signals i{padding:2px 5px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:7px;line-height:10px;font-style:normal;white-space:nowrap}
.bt-teamov-work-signals i[data-state=open]{background:color-mix(in srgb,var(--bt-green) 12%,var(--bt-hover));color:color-mix(in srgb,var(--bt-green) 82%,var(--bt-ink))}
.bt-teamov-work-signals i[data-state=merged]{background:color-mix(in srgb,var(--bt-star) 13%,var(--bt-hover));color:color-mix(in srgb,var(--bt-star) 82%,var(--bt-ink))}
.bt-teamov-work-signals i[data-state=draft]{background:color-mix(in srgb,var(--bt-star) 10%,var(--bt-hover));color:color-mix(in srgb,var(--bt-star) 74%,var(--bt-ink))}
.bt-teamov-work-signals i[data-check=failed]{background:color-mix(in srgb,var(--bt-danger) 12%,var(--bt-hover));color:var(--bt-danger)}
.bt-teamov-work-signals i[data-check=pending]{background:color-mix(in srgb,var(--bt-star) 12%,var(--bt-hover));color:color-mix(in srgb,var(--bt-star) 82%,var(--bt-ink))}
.bt-teamov-work-signals i[data-check=passed]{background:color-mix(in srgb,var(--bt-green) 12%,var(--bt-hover));color:color-mix(in srgb,var(--bt-green) 82%,var(--bt-ink))}
.bt-teamov-work-row>time{color:var(--bt-ink-3);font-size:7px;line-height:10px;text-align:right;white-space:nowrap}
.bt-teamov-work-row>svg{width:11px;height:11px;color:var(--bt-ink-3)}
.bt-teamov-work-foot{min-height:26px;display:flex;align-items:flex-end;justify-content:space-between;gap:8px;border-top:1px solid var(--bt-line)}
.bt-teamov-work-foot>span{color:var(--bt-ink-3);font-size:7px}
.bt-teamov-work-foot>a{display:inline-flex;align-items:center;gap:2px;color:var(--bt-accent);font-size:8px;text-decoration:none}
.bt-teamov-work-foot>a svg{width:10px;height:10px}
.bt-teamov-work-empty{min-height:54px;margin-top:6px;display:flex;align-items:center;gap:8px;color:var(--bt-ink-2)}
.bt-teamov-work-empty.compact{justify-content:center;color:var(--bt-ink-3);font-size:9px}
.bt-teamov-work-empty>svg{width:20px;height:20px;flex:none;color:var(--bt-ink-3)}
.bt-teamov-work-empty>span{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.bt-teamov-work-empty b{font-size:10px;line-height:13px;font-weight:600}
.bt-teamov-work-empty small{color:var(--bt-ink-3);font-size:8px;line-height:11px}
.bt-teamov-work-empty .bt-soft{flex:none}
.bt-teamov-signal-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:7px 0 9px;border-radius:10px;background:var(--bt-line);overflow:hidden}
.bt-teamov-signal{min-width:0;padding:8px;background:var(--bt-card)}
.bt-teamov-signal>span{color:var(--bt-ink-3);font-size:8px;line-height:12px}
.bt-teamov-signal>b{display:block;margin-top:1px;font-size:16px;line-height:20px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-signal>small{display:block;min-height:24px;margin-top:2px;color:var(--bt-ink-3);font-size:8px;line-height:12px}
.bt-teamov-signal[data-tone=good] b{color:var(--bt-green)}
.bt-teamov-signal[data-tone=danger] b{color:var(--bt-danger)}
.bt-teamov-signal[data-tone=quiet] b{color:var(--bt-ink-3)}
.bt-teamov-completion-grid{display:grid;grid-template-columns:1.35fr 1fr;gap:8px}
.bt-teamov-board-block{min-width:0;padding:8px;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-block-title{display:flex;align-items:center;gap:5px;min-width:0;color:var(--bt-ink-3);font-size:8px;line-height:12px}
.bt-teamov-block-title svg{width:11px;height:11px;flex:none}
.bt-teamov-block-title b{flex:none;color:var(--bt-ink-2);font-weight:600}
.bt-teamov-block-title span{min-width:0;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-no-plan{min-height:68px;display:flex;align-items:center;gap:8px;color:var(--bt-ink-3)}
.bt-teamov-no-plan>svg{width:18px;height:18px;flex:none;opacity:.65}
.bt-teamov-no-plan>span{display:flex;flex-direction:column;gap:2px}
.bt-teamov-no-plan b{font-size:10px;line-height:14px;color:var(--bt-ink)}
.bt-teamov-no-plan small{font-size:8px;line-height:12px}
.bt-teamov-goal-flow{display:flex;align-items:flex-start;gap:3px;margin-top:9px;overflow:hidden}
.bt-teamov-goal-node{position:relative;min-width:0;flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}
.bt-teamov-goal-node:not(:last-child)::after{content:"";position:absolute;top:8px;left:calc(50% + 9px);right:calc(-50% + 9px);height:1px;background:var(--bt-line-2)}
.bt-teamov-goal-node>i{position:relative;z-index:1;width:17px;height:17px;display:grid;place-items:center;border-radius:50%;background:var(--bt-hover);color:var(--bt-ink-3);font-size:8px;font-style:normal}
.bt-teamov-goal-node>i svg{width:11px;height:11px}
.bt-teamov-goal-node>span{max-width:100%;color:var(--bt-ink-3);font-size:8px;line-height:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-goal-node[data-state=done]>i{background:var(--bt-green);color:var(--bt-accent-ink)}
.bt-teamov-goal-node[data-state=current]>i{background:var(--bt-accent);color:var(--bt-accent-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-accent) 12%,transparent)}
.bt-teamov-goal-node[data-state=done]>span,.bt-teamov-goal-node[data-state=current]>span{color:var(--bt-ink)}
.bt-teamov-check-matrix{display:flex;flex-direction:column;gap:3px;margin-top:7px}
.bt-teamov-check-matrix>div{min-height:22px;display:grid;grid-template-columns:16px minmax(0,1fr) auto;align-items:center;gap:5px;padding:0 5px;border-radius:6px;background:color-mix(in srgb,var(--bt-ink) 2.5%,transparent)}
.bt-teamov-check-matrix i{display:grid;place-items:center;color:var(--bt-ink-3)}
.bt-teamov-check-matrix i svg{width:10px;height:10px}
.bt-teamov-check-matrix span{min-width:0;color:var(--bt-ink-2);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-check-matrix small{color:var(--bt-ink-3);font-size:7px}
.bt-teamov-check-matrix>div[data-state=passed] i{color:var(--bt-green)}
.bt-teamov-check-matrix>div[data-state=failed] i{color:var(--bt-danger)}
.bt-teamov-check-matrix>div[data-state=failed] small{color:var(--bt-danger)}
.bt-teamov-standards-dossier{margin-top:10px;padding:10px;border-radius:12px;background:color-mix(in srgb,var(--bt-ink) 2.6%,transparent);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-profile-note{display:inline-flex;margin-left:7px;padding:2px 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:8px;font-weight:400;vertical-align:1px}
.bt-teamov-standards-grid{display:grid;grid-template-columns:1.1fr 1fr 1.15fr;gap:8px;margin-top:7px}
.bt-teamov-standard-block{min-width:0;padding:8px;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-standard-block>small{display:block;padding:10px 0;color:var(--bt-ink-3);font-size:8px}
.bt-teamov-file-list,.bt-teamov-source-list{display:flex;flex-direction:column;gap:4px;margin-top:7px}
.bt-teamov-file-list>div{min-height:27px;display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:5px}
.bt-teamov-file-list i{display:grid;place-items:center;color:var(--bt-green)}
.bt-teamov-file-list i svg{width:10px;height:10px}
.bt-teamov-file-list>div[data-missing] i{color:var(--bt-danger)}
.bt-teamov-file-list span{min-width:0;display:flex;flex-direction:column}
.bt-teamov-file-list b{min-width:0;color:var(--bt-ink-2);font-size:9px;line-height:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-file-list small{color:var(--bt-ink-3);font-size:8px;line-height:11px}
.bt-teamov-file-list em{padding:1px 5px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:8px;font-style:normal}
.bt-teamov-source-list>div{min-height:31px;display:flex;align-items:center;gap:7px}
.bt-teamov-source-list>div>span{min-width:0;flex:1;display:flex;flex-direction:column}
.bt-teamov-source-list b{min-width:0;color:var(--bt-ink-2);font-size:9px;line-height:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-source-list small{min-width:0;color:var(--bt-ink-3);font-size:8px;line-height:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-source-list a{flex:none;color:var(--bt-accent);font-size:9px;text-decoration:none}
.bt-teamov-source-list>div[data-stale] small{color:color-mix(in srgb,var(--bt-star) 78%,var(--bt-ink))}
.bt-teamov-experience-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.bt-teamov-experience-chips>span{max-width:100%;padding:4px 7px;display:inline-flex;align-items:center;gap:5px;border-radius:999px;background:var(--bt-hover)}
.bt-teamov-experience-chips b{max-width:180px;color:var(--bt-ink-2);font-size:9px;line-height:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-experience-chips small{max-width:110px;color:var(--bt-ink-3);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-standards-library{margin-top:16px;padding-top:4px;border-top:1px solid var(--bt-line)}
.bt-teamov-standards-library-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.bt-teamov-profile-card{min-width:0;padding:9px;display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;border-radius:12px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-profile-icon{width:30px;height:30px;display:grid;place-items:center;grid-row:1/3;border-radius:10px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-profile-icon svg{width:14px;height:14px}
.bt-teamov-profile-copy{min-width:0;display:flex;align-items:baseline;gap:6px}
.bt-teamov-profile-copy b{font-size:11px;line-height:15px;font-weight:600}
.bt-teamov-profile-copy small{color:var(--bt-ink-3);font-size:8px}
.bt-teamov-profile-stats{grid-column:2;display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}
.bt-teamov-profile-stats>span{min-width:0;padding-left:7px;display:flex;flex-direction:column;border-left:1px solid var(--bt-line)}
.bt-teamov-profile-stats>span:first-child{padding-left:0;border-left:0}
.bt-teamov-profile-stats b{font-size:12px;line-height:15px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-profile-stats small{color:var(--bt-ink-3);font-size:7px;line-height:10px}
.bt-teamov-quiet-block{min-height:58px;display:flex;align-items:center;justify-content:center;gap:6px;color:var(--bt-ink-3);font-size:9px}
.bt-teamov-quiet-block svg{width:13px;height:13px}
.bt-teamov-knowledge,.bt-teamov-experience{padding:10px}
.bt-teamov-knowledge-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:7px}
.bt-teamov-knowledge-tile{min-width:0;min-height:58px;padding:7px;display:flex;flex-direction:column;border-radius:10px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-knowledge-tile>span{width:20px;height:20px;display:grid;place-items:center;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-knowledge-tile svg{width:11px;height:11px}
.bt-teamov-knowledge-tile>b{margin-top:5px;font-size:14px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums}
.bt-teamov-knowledge-tile>small{min-width:0;margin-top:1px;color:var(--bt-ink-3);font-size:8px;line-height:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-knowledge-tile[data-kind=verified] b{color:var(--bt-green)}
.bt-teamov-knowledge-tile[data-kind=skills] b{color:var(--bt-star)}
.bt-teamov-source-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
.bt-teamov-source-row a{max-width:150px;padding:2px 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:8px;line-height:12px;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-source-row a:hover{color:var(--bt-ink)}
.bt-teamov-timeline{position:relative;margin-top:5px}
.bt-teamov-timeline-event{position:relative;border-top:1px solid var(--bt-line)}
.bt-teamov-timeline-event:first-child{border-top:0}
.bt-teamov-timeline-event summary{min-height:34px;display:grid;grid-template-columns:9px 48px minmax(0,1fr);align-items:center;gap:7px;list-style:none;cursor:pointer;color:var(--bt-ink)}
.bt-teamov-timeline-event summary::-webkit-details-marker{display:none}
.bt-teamov-timeline-event summary:hover{background:var(--bt-hover);border-radius:8px}
.bt-teamov-timeline-event summary>i{position:relative;z-index:1;width:6px;height:6px;border-radius:50%;background:var(--bt-line-2);box-shadow:0 0 0 2px var(--bt-card)}
.bt-teamov-timeline-event[data-kind=goal] summary>i,.bt-teamov-timeline-event[data-kind=skill] summary>i{background:var(--bt-star)}
.bt-teamov-timeline-event[data-kind=rules] summary>i,.bt-teamov-timeline-event[data-kind=document] summary>i{background:var(--bt-accent)}
.bt-teamov-timeline-event[data-kind=check] summary>i,.bt-teamov-timeline-event[data-kind=source] summary>i{background:var(--bt-green)}
.bt-teamov-timeline-event[data-kind=change][data-action=committed] summary>i,.bt-teamov-timeline-event[data-kind=progress] summary>i{background:var(--bt-green)}
.bt-teamov-timeline-event[data-kind=change][data-action=working] summary>i,.bt-teamov-timeline-event[data-kind=checkpoint] summary>i{background:var(--bt-star)}
.bt-teamov-timeline-event[data-kind=change][data-action=recorded] summary>i,.bt-teamov-timeline-event[data-kind=decision] summary>i{background:var(--bt-accent)}
.bt-teamov-timeline-event[data-source=github] summary>i{background:var(--bt-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--bt-accent) 13%,transparent)}
.bt-teamov-timeline-event summary>time{color:var(--bt-ink-3);font-size:8px;white-space:nowrap;font-variant-numeric:tabular-nums}
.bt-teamov-timeline-event summary>span{min-width:0;display:flex;align-items:baseline;gap:5px;overflow:hidden}
.bt-teamov-timeline-event summary b{flex:none;color:var(--bt-ink-2);font-size:9px;line-height:13px;font-weight:500;white-space:nowrap}
.bt-teamov-timeline-event summary small{min-width:0;color:var(--bt-ink-3);font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-timeline-event summary::after{content:"";position:absolute;left:4px;top:25px;bottom:-10px;width:1px;background:var(--bt-line)}
.bt-teamov-timeline-event:last-child summary::after{display:none}
.bt-teamov-timeline-detail{margin:0 0 7px 64px;padding:7px 8px;border-radius:8px;background:color-mix(in srgb,var(--bt-ink) 3%,transparent);color:var(--bt-ink-2);font-size:9px;line-height:14px}
.bt-teamov-timeline-detail p{margin:0 0 5px;display:grid;grid-template-columns:48px minmax(0,1fr);gap:7px;overflow-wrap:anywhere}
.bt-teamov-timeline-detail p:last-child{margin-bottom:0}
.bt-teamov-timeline-detail b{color:var(--bt-ink-3);font-size:8px;font-weight:500}
.bt-teamov-timeline-source{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px!important}
.bt-teamov-timeline-files{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:8px!important}
.bt-teamov-mini-kicker{display:flex;align-items:center;gap:5px;color:var(--bt-ink-3);font-size:9px;line-height:13px;font-weight:500}
.bt-teamov-mini-kicker svg{width:12px;height:12px}
.bt-teamov-evidence{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin-top:8px}
.bt-teamov-evidence>span{min-width:0;display:flex;flex-direction:column;gap:3px;color:var(--bt-ink-3);font-size:8px}
.bt-teamov-evidence i{display:block;height:4px;border-radius:999px;background:var(--bt-line-2)}
.bt-teamov-evidence>span[data-on] i{background:var(--bt-green)}
.bt-teamov-evidence.compact{display:flex;gap:4px;margin-top:7px}
.bt-teamov-evidence.compact>span{flex:1;height:5px;border-radius:999px;background:var(--bt-line-2);overflow:hidden}
.bt-teamov-evidence.compact>span[data-on]{background:var(--bt-green)}
.bt-teamov-evidence.compact i{display:none}
.bt-teamov-project-actions{display:flex;align-items:center;gap:6px;padding-top:2px}
.bt-teamov-project-actions .bt-soft{display:inline-flex;align-items:center;gap:5px}
.bt-teamov-project-actions svg{width:13px;height:13px}
.bt-teamov-empty.inline{padding:38px 20px;min-height:180px;border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line)}
.bt-teamov-refreshed{min-height:32px;padding:10px 0 4px;display:flex;align-items:center;justify-content:flex-end;gap:5px;color:var(--bt-ink-3);font-size:9px}
.bt-teamov-refreshed svg{width:11px;height:11px}
.bt-teamov-memory-library{margin-top:16px;padding-top:4px;border-top:1px solid var(--bt-line)}
.bt-teamov-memory-topics{display:flex;flex-wrap:wrap;gap:5px;margin:-2px 0 9px}
.bt-teamov-memory-topics>span{max-width:180px;padding:3px 8px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:10px;line-height:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-memory-topics>.bt-teamov-quiet{background:transparent;color:var(--bt-ink-3);padding-left:0}
.bt-teamov-memory-row{min-height:50px;display:flex;align-items:center;gap:9px;border:0;border-radius:10px;background:transparent;color:var(--bt-ink);text-align:left;font:inherit;cursor:pointer}
.bt-teamov-memory-row:hover{background:var(--bt-hover)}
.bt-teamov-memory-row-icon{width:29px;height:29px;flex:none;display:grid;place-items:center;border-radius:10px;background:color-mix(in srgb,var(--bt-star) 9%,var(--bt-hover));color:var(--bt-ink-2)}
.bt-teamov-memory-row-icon svg{width:14px;height:14px}
.bt-teamov-memory-topic{flex:none;max-width:90px;padding:2px 6px;border-radius:999px;background:var(--bt-hover);color:var(--bt-ink-3);font-size:9px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-agents{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.bt-teamov-agent{min-width:0;border-radius:16px;background:var(--bt-card);box-shadow:inset 0 0 0 1px var(--bt-line);overflow:hidden}
.bt-teamov-agent[data-health=needs],.bt-teamov-agent[data-health=alert],.bt-teamov-agent[data-health=blocked]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--bt-accent) 28%,var(--bt-line))}
.bt-teamov-agent-head{min-height:58px;padding:10px;display:flex;align-items:center;gap:9px}
.bt-teamov-agent-glyph{width:38px;height:38px;flex:none;display:grid;place-items:center;border-radius:50%;background:var(--bt-hover);color:var(--bt-ink-2)}
.bt-teamov-agent-glyph svg{width:18px;height:18px}
.bt-teamov-agent-title{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}
.bt-teamov-agent-title>b{min-width:0;display:flex;align-items:center;font-size:13px;line-height:18px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-agent-title>small{min-width:0;color:var(--bt-ink-3);font-size:9px;line-height:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-agent .bt-round{width:28px;height:28px;flex:none}
.bt-teamov-agent .bt-round svg{width:14px;height:14px}
.bt-teamov-agent-grid{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--bt-line);border-top:1px solid var(--bt-line);border-bottom:1px solid var(--bt-line)}
.bt-teamov-agent-metric{min-width:0;padding:9px 10px;background:var(--bt-card)}
.bt-teamov-agent-metric.wide{grid-column:1/-1;border-top:1px solid var(--bt-line)}
.bt-teamov-agent-metric>b{display:block;margin-top:5px;font-size:12px;line-height:17px;font-weight:600}
.bt-teamov-agent-metric>small{display:block;margin-top:3px;color:var(--bt-ink-3);font-size:9px;line-height:13px}
.bt-teamov-learning-bar{height:5px;margin-top:8px;display:flex;gap:2px;overflow:hidden;border-radius:999px;background:var(--bt-line)}
.bt-teamov-learning-bar i{min-width:0;height:100%;border-radius:999px}
.bt-teamov-learning-bar .approved{background:var(--bt-green)}
.bt-teamov-learning-bar .declined{background:color-mix(in srgb,var(--bt-danger) 65%,var(--bt-line-2))}
.bt-teamov-learning-bar .pending{background:var(--bt-star)}
.bt-teamov-learning-bar .empty{flex:1;background:var(--bt-line-2)}
.bt-teamov-check-row{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.bt-teamov-check-row>span{padding:2px 6px;border-radius:6px;background:var(--bt-hover);color:var(--bt-ink-2);font-size:8px;line-height:12px}
.bt-teamov-agent-foot{min-height:36px;padding:7px 10px;display:flex;align-items:center;gap:6px;color:var(--bt-ink-3);font-size:9px}
.bt-teamov-agent-foot>span:first-child{min-width:0;display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-agent-foot svg{width:12px;height:12px}
.bt-teamov-link{margin-left:auto;padding:3px 6px;border:0;border-radius:6px;background:transparent;color:var(--bt-ink-2);font:inherit;font-size:9px;cursor:pointer}
.bt-teamov-link:hover{background:var(--bt-hover);color:var(--bt-ink)}
.bt-teamov-folder{max-width:100px;margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bt-teamov-live-note{display:inline-flex;align-items:center;gap:5px;color:var(--bt-ink-3);font-size:10px}
.bt-teamov-live-note i{width:6px;height:6px;border-radius:50%;background:var(--bt-line-2)}
.bt-teamov-live-note i[data-live]{background:var(--bt-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--bt-green) 13%,transparent);animation:bt-teamov-live 1.8s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.bt-teamov,.bt-teamov-scrim,.bt-teamov-skeleton i,.bt-teamov-ring,.bt-teamov-live-row::before,.bt-teamov-live-note i[data-live],.bt-teamov-refresh svg{animation:none!important}}
@media (max-width:1100px){.bt-teamov-standards-grid{grid-template-columns:1fr 1fr}.bt-teamov-standard-block:last-child{grid-column:1/-1}}
@media (max-width:980px){.bt-teamov-projects{grid-template-columns:1fr}.bt-teamov-agents{grid-template-columns:repeat(2,minmax(0,1fr))}.bt-teamov-project-insights{grid-template-columns:1fr}}
@media (max-width:640px){.bt-teamov-tab{top:78px;width:26px;min-height:88px}.bt-teamov-tab:hover{width:30px}.bt-teamov-tab span{font-size:8px}.bt-teamov-layer{padding:0}.bt-teamov{width:100%;height:100%;max-height:none;border:0;border-radius:0}.bt-teamov-top{height:68px;padding-inline:14px}.bt-teamov-summary{grid-template-columns:50px minmax(0,1fr);gap:12px;padding-inline:14px}.bt-teamov-ring{width:50px;height:50px}.bt-teamov-ring::before{inset:6px}.bt-teamov-stats{grid-template-columns:1fr 1fr;gap:7px 0}.bt-teamov-stat{padding-inline:9px}.bt-teamov-stat:nth-child(3){padding-left:0;border-left:0}.bt-teamov-body{padding-inline:14px}.bt-teamov-portfolio{padding-inline:14px;grid-template-columns:42px minmax(0,1fr);gap:9px}.bt-teamov-portfolio-stats{grid-column:1/-1;grid-template-columns:repeat(5,minmax(0,1fr))}.bt-teamov-portfolio-stats>span{padding-inline:7px}.bt-teamov-portfolio-stats b{font-size:15px}.bt-teamov-portfolio-stats small{font-size:8px}.bt-teamov-databar{padding-inline:10px}.bt-teamov-tabitem{padding-inline:8px}.bt-teamov-tabitem svg{display:none}.bt-teamov-refresh span{display:none}.bt-teamov-project-side{max-width:46%}.bt-teamov-project-state{justify-content:flex-end;text-align:right;white-space:normal}.bt-teamov-project-progress{padding-left:12px}.bt-teamov-standards-grid{grid-template-columns:1fr}.bt-teamov-standard-block:last-child{grid-column:auto}.bt-teamov-standards-library-grid{grid-template-columns:1fr}.bt-teamov-completion-grid{grid-template-columns:1fr}.bt-teamov-project-insights{grid-template-columns:1fr}.bt-teamov-knowledge-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.bt-teamov-signal>small{min-height:0}.bt-teamov-agents{grid-template-columns:1fr}.bt-teamov-projects{grid-template-columns:1fr}.bt-teamov-memory-topic{display:none}.bt-teamov-add-project{flex-wrap:wrap}.bt-teamov-add-project input{flex-basis:100%}}
@media (max-width:640px){.bt-teamov-work-toolbar{align-items:flex-start;flex-direction:column}.bt-teamov-work-row{grid-template-columns:39px minmax(0,1fr) 12px}.bt-teamov-work-row>time{display:none}.bt-teamov-work-signals{grid-column:2;justify-content:flex-start}.bt-teamov-work-row>svg{grid-column:3;grid-row:1/3}.bt-teamov-work-foot{align-items:center}.bt-teamov-work-empty{flex-wrap:wrap}.bt-teamov-work-empty .bt-soft{margin-left:28px}}
@media (max-width:520px){body:has(.tbh) .bt-teamov-tab{top:calc(46vh + 12px);right:0}body:has(.tbh-toggle) .bt-teamov-tab{right:0}}
${SITES_CSS}
`
