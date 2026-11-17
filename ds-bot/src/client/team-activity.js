// A read-only team activity surface: the task rows and activity records already owned
// by DS Bot, with no second task state and no client-side completion rules.
import { createElement as h, useEffect, useRef, useState } from 'react'
import { call as apiCall } from './api.js'
import { hostText, t } from './i18n.js'
import { BotAvatar } from './mark.js'
import { ProposalCard } from './learning-card-view.js'
import { SPRING_SHAPE } from './motion.js'
import { useEscape } from './overlay-hooks.js'

const copyText = () => ({
  title: t('Team activity'),
  subtitle: t('Real tasks, handoffs, and recent activity'),
  live: t('Live data'),
  demo: t('Demo data'),
  readOnly: t('Read-only'),
  readOnlyHost: t('Read-only host'),
  close: t('Close'),
  active: t('Active'),
  waiting: t('Waiting'),
  attention: t('Needs attention'),
  activity: t('Activity'),
  empty: t('No team activity yet. Real records appear here once Bots start working.'),
  error: t('Team activity could not be read.'),
  loading: t('Loading team activity…'),
  all: t('All'),
  role: t('Role'),
  source: t('Source'),
  status: t('Status'),
  waitingAttention: t('Waiting + attention'),
  task: t('Task'),
  recent: t('Recent activity'),
  goal: t('Goal'),
  goalTask: t('Goal task'),
  handoff: t('Handoff'),
  board: t('Team board'),
  ledger: t('Task ledger'),
  detail: t('Source and next step'),
  parent: t('Parent'),
  children: t('Children'),
  room: t('Group chat'),
  owner: t('Owner'),
  acceptance: t('Acceptance'),
  note: t('Note'),
  evidence: t('Evidence'),
  noDetail: t('Select a task to see its source and context.'),
  roster: t('Team roster'),
  member: t('Member'),
  mainBot: t('Main Bot'),
  partial: t('Partial data'),
  stale: t('Could not refresh. Showing the last good result.'),
  noMatch: t('No tasks match these filters.'),
  noCurrentTasks: t('No current tasks.'),
  sevenDay: t('Seven-day activity'),
  activityOnly: t('Activity records, not task completion.'),
  sourceId: t('Source ID'),
  stage: t('Stage'),
  warning: t('Warning'),
  noOwner: t('No owner'),
  attempt: t('Attempt'),
  handoffRoute: t('Handoff route'),
  recovery: t('Recovery'),
  latestCheckpoint: t('Latest checkpoint'),
  nextAction: t('Next action'),
  blockers: t('Blockers'),
  artifacts: t('Artifacts'),
  traceExplorer: t('Trace Explorer'),
  timeline: t('Timeline'),
  relationships: t('Relationships'),
  records: t('Records'),
  reported: t('Reported'),
  executed: t('Executed'),
  verified: t('Verified'),
  requested: t('Requested'),
  pending: t('Pending'),
  noBlockers: t('No known blockers.'),
  noEvidence: t('No evidence is attached yet.'),
  noArtifacts: t('No artifacts are attached yet.'),
  noTrace: t('No Session records are linked to this task yet.'),
  tracePartial: t('The trace may be incomplete.'),
  traceTruncated: t('Older Session records are not shown.'),
  none: t('None'),
  detailLoading: t('Loading task detail…'),
  detailStale: t('Could not refresh this task. Showing the last good detail.'),
  detailUnavailable: t('This task is no longer available.'),
  detailError: t('Task detail could not be read.'),
  pauseGoal: t('Pause goal'),
  resumeGoal: t('Resume goal'),
  stopGoal: t('Stop goal'),
  retryBot: t('Retry Bot'),
  cancelWork: t('Stop current work'),
  abandonWait: t('Abandon wait'),
  verification: t('Verification'),
  improvements: t('Improvement proposals'),
  proposeImprovement: t('Propose improvement'),
  proposingImprovement: t('Reading verified evidence…'),
  noImprovement: t('No reusable improvement was found in this verified evidence.'),
  noImprovements: t('No improvements have been proposed for this task yet.'),
  proposalError: t('The improvement proposal could not be created.'),
  verifiedOnly: t('Only verified task evidence can produce an improvement proposal.'),
})

const sourceLabel = (source, copy) => source === 'goal' ? copy.goalTask
  : source === 'handoff' ? copy.handoff
    : source === 'board' ? copy.board
      : source === 'ledger' ? copy.ledger : source
const permissionOf = (role, copy) => !role ? '' : role.main ? copy.mainBot : copy.member

export function filterActivityModel(data, filters = {}) {
  const role = filters.role ?? 'all'
  const source = filters.source ?? 'all'
  const status = filters.status ?? 'all'
  const attention = filters.attention === true
  const attentionStatuses = new Set(data?.filters?.attentionStatuses ?? [])
  const tasks = (data?.tasks ?? []).filter(task => (role === 'all' || task.ownerId === role)
    && (source === 'all' || task.source === source)
    && (status === 'all' || task.sourceStatus === status)
    && (!attention || attentionStatuses.has(task.sourceStatus)))
  return data ? { ...data, tasks } : { tasks }
}

const botFor = (roster, task, role) => ({
  ...roster?.byId?.[task.ownerId],
  id: task.ownerId,
  name: task.ownerName || roster?.byId?.[task.ownerId]?.name || role?.name,
  role: task.ownerRole || roster?.byId?.[task.ownerId]?.role || role?.role,
  main: role?.main === true,
})

const when = at => {
  if (!Number.isFinite(at)) return ''
  const date = new Date(at)
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function OwnerMark({ task, roster, role, copy, size }) {
  if (task.ownerKind !== 'bot' || !task.ownerId) {
    return h('span', { className: 'bt-activity-owner-mark', style: { width: size, height: size }, 'aria-label': task.ownerName || copy.noOwner }, task.ownerKind === 'group' ? 'G' : '?')
  }
  return h(BotAvatar, { bot: botFor(roster, task, role), size, state: task.displayState ?? 'idle', main: role?.main === true })
}

function DialogHead({ copy, onClose, data, partial, roster }) {
  const lockReason = typeof roster?.readOnly === 'string' ? roster.readOnly.trim() : ''
  return h('header', { className: 'bt-activity-head' },
    h('div', null, h('h2', null, copy.title), h('p', null, copy.subtitle)),
    h('div', { className: 'bt-activity-head-meta' },
      data ? h('span', { className: 'bt-activity-mode', 'data-mode': data.mode ?? 'live' }, data.mode === 'live' ? copy.live : copy.demo) : null,
      partial ? h('span', { className: 'bt-activity-mode', 'data-partial': true }, copy.partial) : null,
      h('span', { className: 'bt-activity-mode', 'data-host-locked': lockReason || undefined, title: lockReason ? hostText(lockReason) : undefined }, lockReason ? copy.readOnlyHost : copy.readOnly),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-activity-close', onClick: onClose }, copy.close)))
}

function Filter({ label, value, options, allLabel, onChange }) {
  return h('label', { className: 'bt-activity-filter' },
    h('span', null, label),
    h('select', { className: 'bt-select', value, onChange: event => onChange(event.target.value) },
      h('option', { value: 'all' }, allLabel),
      options.map(option => h('option', { key: option.value, value: option.value }, option.label))))
}

function RoleStrip({ roles, copy }) {
  if (roles.length === 0) return null
  return h('div', { className: 'bt-activity-roster-wrap' },
    h('div', { className: 'bt-activity-section-head' }, h('span', null, copy.roster)),
    h('div', { className: 'bt-activity-roster', 'aria-label': copy.roster },
      roles.map(role => h('div', { key: role.id, className: 'bt-activity-role', 'data-main': role.main || undefined },
        h(BotAvatar, { bot: role, size: 28, main: role.main }),
        h('span', { className: 'bt-activity-role-copy' },
          h('b', null, role.name),
          h('small', null, role.role || copy.member)),
        h('em', null, permissionOf(role, copy))))))
}

function TaskRow({ task, roster, role, selected, copy, onSelect }) {
  const roleLabel = task.ownerRole || role?.role
  return h('button', { type: 'button', className: 'bt-activity-task', 'data-task-id': task.id, 'data-source': task.source, 'data-status': task.sourceStatus, 'data-owner-kind': task.ownerKind, 'data-selected': selected || undefined, onClick: () => onSelect(task.id) },
    h(OwnerMark, { task, roster, role, copy, size: 30 }),
    h('span', { className: 'bt-activity-task-main' },
      h('span', { className: 'bt-activity-task-title' }, task.title || task.sourceId),
      h('span', { className: 'bt-activity-task-meta' }, `${sourceLabel(task.source, copy)} · ${task.ownerName || copy.noOwner}${roleLabel ? ` · ${roleLabel}` : ''}`),
      h('span', { className: 'bt-activity-task-state', 'data-status': task.sourceStatus }, task.sourceStatus)),
    h('time', { className: 'bt-activity-task-time' }, when(task.updatedAt)))
}

const trustLabel = (trust, copy) => trust === 'verified' ? copy.verified
  : trust === 'executed' ? copy.executed
    : trust === 'requested' ? copy.requested
      : trust === 'reported' ? copy.reported : copy.pending

const controlLabel = (id, copy) => id === 'pause-goal' ? copy.pauseGoal
  : id === 'resume-goal' ? copy.resumeGoal
    : id === 'stop-goal' ? copy.stopGoal
      : id === 'retry-bot' ? copy.retryBot
        : id === 'cancel-work' || id === 'cancel-room' ? copy.cancelWork
          : id === 'abandon-work' ? copy.abandonWait : id

function TraceRow({ item, copy, selected, onSelect }) {
  return h('button', {
    type: 'button',
    className: 'bt-trace-record',
    'data-trace-id': item.id,
    'data-trust': item.trust,
    'data-selected': selected || undefined,
    onClick: () => onSelect(item),
  },
  h('span', { className: 'bt-trace-record-main' },
    h('b', null, item.title || item.type),
    h('span', null, item.detail || ''),
    h('small', null, [item.sessionId, item.seq === null || item.seq === undefined ? '' : `#${item.seq}`].filter(Boolean).join(' · '))),
  h('span', { className: 'bt-trace-trust', 'data-trust': item.trust }, trustLabel(item.trust, copy)),
  h('time', null, when(item.at)))
}

export function TraceExplorer({ trace, copy, view: forcedView, onSelectEvidence = () => {} }) {
  const [localView, setLocalView] = useState('timeline')
  const [selectedRecordId, setSelectedRecordId] = useState(null)
  const view = forcedView ?? localView
  const changeView = next => {
    if (forcedView === undefined) setLocalView(next)
  }
  const selectRecord = (item) => {
    setSelectedRecordId(item.id)
    if (item.relatedEvidenceId) onSelectEvidence(item.relatedEvidenceId)
  }
  const records = Array.isArray(trace?.timeline) ? trace.timeline : []
  const relationships = Array.isArray(trace?.relationships) ? trace.relationships : []
  const recordRows = records.map(item => h(TraceRow, { key: item.id, item, copy, selected: selectedRecordId === item.id, onSelect: selectRecord }))
  const tab = (id, label) => h('button', {
    type: 'button', className: 'bt-trace-tab', 'data-view': id, 'aria-pressed': view === id,
    onClick: () => changeView(id),
  }, label)
  return h('section', { className: 'bt-trace-explorer', 'aria-label': copy.traceExplorer },
    h('div', { className: 'bt-trace-head' }, h('h4', null, copy.traceExplorer), h('small', { className: 'bt-activity-id' }, trace?.sourceId || trace?.sourceTaskId || '')),
    h('div', { className: 'bt-trace-tabs', role: 'tablist' }, tab('timeline', copy.timeline), tab('relationships', copy.relationships), tab('records', copy.records)),
    trace?.status === 'partial' ? h('p', { className: 'bt-trace-note', role: 'status' }, copy.tracePartial) : null,
    view === 'relationships'
      ? relationships.length > 0
        ? h('div', { className: 'bt-trace-relations' }, relationships.map((item, index) => h('div', { key: `${item.kind}:${index}`, className: 'bt-trace-relation', 'data-kind': item.kind },
          h('b', null, item.kind), h('span', null, `${item.from} → ${item.to}`))))
        : h('p', { className: 'bt-activity-detail-empty' }, copy.noTrace)
      : records.length > 0
        ? h('div', { className: 'bt-trace-list', role: view === 'timeline' ? 'list' : undefined }, recordRows)
        : h('p', { className: 'bt-activity-detail-empty' }, copy.noTrace),
    trace?.truncated ? h('p', { className: 'bt-trace-note' }, copy.traceTruncated) : null)
}

function EvidenceList({ evidence, selectedId, copy, onSelect }) {
  if (evidence.length === 0) return h('p', { className: 'bt-activity-detail-empty' }, copy.noEvidence)
  return h('div', { className: 'bt-task-evidence-list' }, evidence.map(item => h('button', {
    key: item.id, type: 'button', className: 'bt-task-evidence', 'data-trust': item.trust,
    'data-evidence-id': item.id, 'data-selected': selectedId === item.id || undefined,
    onClick: () => onSelect(item.id),
  },
  h('span', null,
    h('b', null, item.title || item.text || item.id),
    item.title && item.text ? h('span', null, item.text) : null,
    h('small', null, `${item.sourceId || ''}${item.at ? ` · ${when(item.at)}` : ''}`)),
  h('em', null, trustLabel(item.trust, copy)))))
}

function Detail({ task, detail, detailStatus, detailError, roster, rolesById, allTasks, actions, copy }) {
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(null)
  const [improvements, setImprovements] = useState(detail?.improvements ?? { proposals: [], history: [] })
  const [proposalBusy, setProposalBusy] = useState(false)
  const [proposalError, setProposalError] = useState('')
  const [proposalNotice, setProposalNotice] = useState('')
  useEffect(() => {
    if (detail?.improvements) setImprovements(detail.improvements)
    setProposalError('')
    setProposalNotice('')
  }, [detail?.taskId, detail?.generatedAt])
  if (!task) return h('aside', { className: 'bt-activity-detail' }, h('p', { className: 'bt-activity-detail-empty' }, copy.noDetail))
  const shown = detail?.task ?? task
  const role = rolesById.get(shown.ownerId)
  const parent = shown.parentId ? allTasks.find(item => item.id === shown.parentId) : undefined
  const children = allTasks.filter(item => item.parentId === shown.id)
  const linkedHandoffs = Array.isArray(detail?.handoffs) ? detail.handoffs : []
  const childRows = [
    ...children,
    ...linkedHandoffs.filter(item => !children.some(child => child.id === item.id)),
  ]
  const parentText = parent?.title || (shown.source === 'goal' && shown.subtitle ? `${copy.goal}: ${shown.subtitle}` : shown.parentId)
  const warnings = [
    ...(Array.isArray(shown.warnings) ? shown.warnings : []),
    ...(Array.isArray(detail?.warnings) ? detail.warnings.map(item => item.message).filter(Boolean) : []),
  ]
  const stageTitle = detail?.location?.stageTitle || shown.stageTitle
  const blockers = Array.isArray(detail?.blockers) ? detail.blockers : []
  const attempt = detail?.attempt
  const handoff = detail?.handoff
  const recovery = detail?.recovery
  const evidence = Array.isArray(detail?.evidence) ? detail.evidence : []
  const artifacts = Array.isArray(detail?.artifacts) ? detail.artifacts : []
  const controls = Array.isArray(detail?.controls) ? detail.controls : []
  const lockReason = typeof roster?.readOnly === 'string' ? roster.readOnly.trim() : ''
  const visibleControls = controls.map(control => lockReason ? { ...control, enabled: false, reason: lockReason } : control)
  const verified = detail?.verification?.status === 'verified' && detail?.empty !== true
  const canPropose = verified && shown.ownerKind === 'bot' && Boolean(actions?.proposeImprovement) && !lockReason && !proposalBusy
  const proposalDisabledReason = lockReason || (verified ? '' : copy.verifiedOnly)
  const proposalCards = [...(improvements.proposals ?? []), ...(improvements.history ?? [])]
  const proposeImprovement = () => {
    if (!canPropose) return
    setProposalBusy(true)
    setProposalError('')
    setProposalNotice('')
    let result
    try {
      result = actions.proposeImprovement(shown.id)
    } catch (error) {
      setProposalError(error?.message ?? String(error))
      setProposalBusy(false)
      return
    }
    void Promise.resolve(result).then(proposal => {
      if (proposal) setImprovements(current => ({ ...current, proposals: [...(current.proposals ?? []), proposal] }))
      else setProposalNotice(copy.noImprovement)
    }, error => setProposalError(error?.message ?? String(error))).finally(() => setProposalBusy(false))
  }
  const proposalResolved = (id, approve) => setImprovements(current => ({
    ...current,
    proposals: (current.proposals ?? []).map(proposal => proposal.id === id
      ? { ...proposal, outcome: approve ? 'approved' : 'declined' }
      : proposal),
  }))
  const runControl = (control) => {
    if (!control.enabled || !actions) return
    if (control.id === 'pause-goal') void actions.goalControl?.(control.roomId, control.goalId, 'pause')
    else if (control.id === 'resume-goal') void actions.goalControl?.(control.roomId, control.goalId, 'resume')
    else if (control.id === 'stop-goal') void actions.goalControl?.(control.roomId, control.goalId, 'stop')
    else if (control.id === 'retry-bot') void actions.resume?.(control.botId)
    else if (control.id === 'cancel-work') void actions.stopMemberWork?.(control.roomId, control.botId)
    else if (control.id === 'cancel-room') void actions.stopRoomWork?.(control.roomId)
    else if (control.id === 'abandon-work') void actions.abandonWork?.(control.workId)
  }
  const detailNotice = detailStatus === 'loading' && detail === null ? h('p', { className: 'bt-task-detail-state', role: 'status' }, copy.detailLoading)
    : detail?.empty === true ? h('p', { className: 'bt-task-detail-state', role: 'status' }, copy.detailUnavailable)
      : detailError ? h('p', { className: 'bt-task-detail-state', role: 'alert' }, detail ? copy.detailStale : (detailError || copy.detailError), detail ? h('span', null, detailError) : null) : null
  return h('aside', { className: 'bt-activity-detail', 'aria-label': copy.detail },
    h('div', { className: 'bt-activity-detail-head' },
      h(OwnerMark, { task: shown, roster, role, copy, size: 38 }),
      h('div', null,
        h('b', null, shown.title || shown.sourceId),
        h('span', null, `${sourceLabel(shown.source, copy)} · ${shown.ownerName || copy.noOwner}`),
        h('small', { 'data-main': role?.main || undefined }, shown.ownerKind === 'group' ? copy.room : role ? `${shown.ownerRole || role.role || copy.member} · ${permissionOf(role, copy)}` : copy.noOwner))),
    detailNotice,
    h('dl', null,
      h('div', null, h('dt', null, copy.status), h('dd', null, h('span', { className: 'bt-activity-status', 'data-status': shown.sourceStatus }, shown.sourceStatus))),
      h('div', null, h('dt', null, copy.sourceId), h('dd', { className: 'bt-activity-id' }, shown.sourceId || shown.id)),
      ...(stageTitle ? [h('div', { key: 'stage' }, h('dt', null, copy.stage), h('dd', null, stageTitle))] : []),
      ...(detail && attempt ? [h('div', { key: 'attempt' }, h('dt', null, copy.attempt), h('dd', null, h('span', { className: 'bt-activity-id' }, `${attempt.id || copy.none}${attempt.number ? ` · ${attempt.number}` : ''}${attempt.status ? ` · ${attempt.status}` : ''}`)))] : []),
      ...(detail && handoff ? [h('div', { key: 'handoff' }, h('dt', null, copy.handoffRoute), h('dd', null, [handoff.from?.name || handoff.from?.id, handoff.to?.name || handoff.to?.id].filter(Boolean).join(' → ') || copy.none, handoff.status ? ` · ${handoff.status}` : '', handoff.name ? ` · ${handoff.name}` : ''))] : []),
      ...(detail ? [h('div', { key: 'checkpoint' }, h('dt', null, copy.latestCheckpoint), h('dd', null, detail.checkpoint?.text || copy.none))] : []),
      ...(detail && recovery ? [h('div', { key: 'recovery' }, h('dt', null, copy.recovery), h('dd', null, recovery.records?.length > 0 ? recovery.records.map(item => `${item.kind}: ${item.summary}`).join(' · ') : copy.none))] : []),
      ...(detail ? [h('div', { key: 'next' }, h('dt', null, copy.nextAction), h('dd', null, detail.nextAction?.text || copy.none))] : []),
      ...(detail ? [h('div', { key: 'blockers' }, h('dt', null, copy.blockers), h('dd', null, blockers.length > 0
        ? h('ul', { className: 'bt-task-blockers' }, blockers.map(item => h('li', { key: item.id, 'data-kind': item.kind }, item.text)))
        : copy.noBlockers))] : []),
      ...(parentText ? [h('div', { key: 'parent' }, h('dt', null, copy.parent), h('dd', null, parentText))] : []),
      ...(childRows.length > 0 ? [h('div', { key: 'children' }, h('dt', null, copy.children), h('dd', null,
        h('ul', { className: 'bt-activity-children' }, childRows.map(child => h('li', { key: child.id }, child.title || child.sourceId || child.id))))) ] : []),
      ...(shown.roomName ? [h('div', { key: 'room' }, h('dt', null, copy.room), h('dd', null, shown.roomName))] : []),
      ...(shown.acceptance ? [h('div', { key: 'acceptance' }, h('dt', null, copy.acceptance), h('dd', null, shown.acceptance))] : []),
      ...(shown.note ? [h('div', { key: 'note' }, h('dt', null, copy.note), h('dd', null, shown.note))] : []),
      ...(!detail && shown.evidence ? [h('div', { key: 'evidence' }, h('dt', null, copy.evidence), h('dd', null, shown.evidence))] : []),
      ...(detail ? [h('div', { key: 'verification' }, h('dt', null, copy.verification), h('dd', null, `${detail.verification?.status || copy.pending}${detail.verification?.reason ? ` · ${detail.verification.reason}` : ''}`))] : []),
      ...(warnings.length > 0 ? [h('div', { key: 'warning', className: 'bt-activity-warning' }, h('dt', null, copy.warning), h('dd', null, warnings.join(' · ')))] : [])),
    detail ? h('section', { className: 'bt-task-section bt-improvement-section' },
      h('div', { className: 'bt-improvement-head' },
        h('h4', null, copy.improvements),
        h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm bt-improvement-propose',
          disabled: !canPropose, title: proposalDisabledReason || undefined, onClick: proposeImprovement,
        }, proposalBusy ? copy.proposingImprovement : copy.proposeImprovement)),
      proposalError ? h('p', { className: 'bt-learning-error', role: 'alert' }, `${copy.proposalError} ${proposalError}`) : null,
      proposalNotice ? h('p', { className: 'bt-activity-detail-empty', role: 'status' }, proposalNotice) : null,
      proposalCards.length > 0
        ? h('div', { className: 'bt-improvement-list' }, proposalCards.map(proposal => h(ProposalCard, {
          key: proposal.id,
          proposal,
          actions,
          onResolved: proposalResolved,
          disabledReason: proposal.outcome ? '' : lockReason,
        })))
        : h('p', { className: 'bt-activity-detail-empty' }, copy.noImprovements)) : null,
    detail ? h('section', { className: 'bt-task-section' },
      h('h4', null, copy.evidence),
      h(EvidenceList, { evidence, selectedId: selectedEvidenceId, copy, onSelect: setSelectedEvidenceId })) : null,
    detail ? h('section', { className: 'bt-task-section' },
      h('h4', null, copy.artifacts),
      artifacts.length > 0 ? h('div', { className: 'bt-task-artifacts' }, artifacts.map((item, index) => h('div', {
        key: `${item.path}:${item.digest ?? index}`, className: 'bt-task-artifact', 'data-trust': item.trust,
      }, h('b', null, item.name || item.path), h('span', { className: 'bt-activity-id' }, item.path), h('small', null, item.digest || '')))) : h('p', { className: 'bt-activity-detail-empty' }, copy.noArtifacts)) : null,
    detail && detail.empty !== true ? h(TraceExplorer, { trace: detail.trace, copy, onSelectEvidence: setSelectedEvidenceId }) : null,
    visibleControls.length > 0 ? h('div', { className: 'bt-detail-controls', 'aria-label': copy.detail }, visibleControls.map(control => h('button', {
      key: control.id, type: 'button', className: 'bt-soft bt-soft-sm bt-detail-control', 'data-control': control.id,
      disabled: !control.enabled, title: control.reason || undefined, onClick: () => runControl(control),
    }, controlLabel(control.id, copy)))) : null)
}

export function TeamActivityView({ data, roster, status = 'ready', error = '', selectedId = null, filters = {}, detail = null, detailStatus = 'idle', detailError = '', actions, onSelect = () => {}, onFilter = () => {}, onClose = () => {}, leaving = false }) {
  const copy = copyText()
  const partialData = data
  const partialWarnings = Array.isArray(partialData?.warnings) ? partialData.warnings.map(item => item.message).filter(Boolean) : []
  if (status === 'error' && !data) {
    return h('section', { className: 'bt-team-activity', role: 'dialog', 'aria-modal': true, 'aria-label': copy.title, 'aria-busy': false, 'data-leaving': leaving || undefined },
      h(DialogHead, { copy, onClose, roster }),
      h('p', { className: 'bt-error bt-activity-error', role: 'alert' }, error || copy.error))
  }
  if (status === 'loading' && !data) {
    return h('section', { className: 'bt-team-activity', role: 'dialog', 'aria-modal': true, 'aria-label': copy.title, 'aria-busy': true, 'data-leaving': leaving || undefined },
      h(DialogHead, { copy, onClose, roster }),
      h('div', { className: 'bt-activity-skeleton', role: 'status', 'aria-label': copy.loading }, h('span'), h('span'), h('span')))
  }

  const view = filterActivityModel(data, filters)
  const tasks = view.tasks ?? []
  const allTasks = data?.tasks ?? []
  const activity = data?.activity ?? []
  const roles = data?.roles ?? []
  const rolesById = new Map(roles.map(role => [role.id, role]))
  const selected = tasks.find(task => task.id === selectedId) ?? tasks[0] ?? null
  const selectedDetail = detail?.taskId === selected?.id || detail?.task?.id === selected?.id ? detail : null
  const empty = allTasks.length === 0 && activity.length === 0
  const noMatch = allTasks.length > 0 && tasks.length === 0
  const noCurrentTasks = allTasks.length === 0
  const statuses = [...new Set(allTasks.map(task => task.sourceStatus).filter(Boolean))].map(status => ({ value: status, label: status }))
  const sourceKeys = data?.filters?.sources ?? ['goal', 'handoff']
  const warningMessages = partialWarnings.length > 0 ? partialWarnings : allTasks.flatMap(task => task.warnings ?? [])
  const partial = data?.partial === true || warningMessages.length > 0
  const lockReason = typeof roster?.readOnly === 'string' ? roster.readOnly.trim() : ''
  const heatmap = (data?.heatmap ?? []).map(cell => h('span', {
    key: cell.day,
    className: 'bt-activity-heat-cell',
    'data-day': cell.day,
    'data-count': cell.count,
    style: { '--bt-heat': Math.min(4, cell.count) / 4 },
    title: `${cell.day} · ${cell.count}`,
  }, h('b', null, String(cell.count)), h('small', null, cell.day.slice(5))))
  const taskRows = tasks.map(task => h(TaskRow, {
    key: task.id,
    task,
    roster,
    role: rolesById.get(task.ownerId),
    selected: selected?.id === task.id,
    copy,
    onSelect,
  }))
  const activityRows = activity.slice(0, 12).map(item => h('div', {
    key: item.id,
    className: 'bt-activity-record',
    'data-source': item.source,
    'data-kind': item.kind,
  },
  h('b', null, item.botName || 'DS Bot'),
  h('span', null, `${sourceLabel(item.source, copy)}${item.kind ? ` · ${item.kind}` : ''} · ${item.text}`),
  h('time', null, when(item.at))))
  const taskMessage = noMatch ? copy.noMatch : noCurrentTasks ? copy.noCurrentTasks : ''
  const body = empty
    ? h('div', { className: 'bt-empty bt-activity-empty', role: 'status' }, copy.empty)
    : h('div', { className: 'bt-activity-body' },
      h('div', { className: 'bt-activity-list' }, taskMessage ? h('p', { className: 'bt-empty bt-activity-no-task' }, taskMessage) : taskRows),
      h(Detail, { task: selected, detail: selectedDetail, detailStatus, detailError, roster, rolesById, allTasks, actions, copy }),
      h('div', { className: 'bt-activity-recent' },
        h('h3', null, copy.recent),
        activityRows.length > 0 ? activityRows : h('p', { className: 'bt-activity-detail-empty' }, copy.empty)))
  return h('section', { className: 'bt-team-activity', role: 'dialog', 'aria-modal': true, 'aria-label': copy.title, 'data-leaving': leaving || undefined, 'data-partial': partial || undefined },
    h(DialogHead, { copy, onClose, data, partial, roster }),
    error ? h('p', { className: 'bt-activity-stale', role: 'status' }, copy.stale, h('span', null, error)) : null,
    lockReason ? h('p', { className: 'bt-activity-host-read-only', role: 'status' }, copy.readOnlyHost, h('span', null, hostText(lockReason))) : null,
    partial ? h('p', { className: 'bt-activity-partial-note', role: 'status' }, `${copy.partial}: ${warningMessages.join(' · ')}`) : null,
    h('div', { className: 'bt-activity-summary' },
      h('span', null, h('b', null, String(data?.summary?.active ?? 0)), copy.active),
      h('span', null, h('b', null, String(data?.summary?.waiting ?? 0)), copy.waiting),
      h('span', null, h('b', null, String(data?.summary?.attention ?? 0)), copy.attention),
      h('span', null, h('b', null, String(data?.summary?.activity ?? 0)), copy.activity)),
    h(RoleStrip, { roles, copy }),
    h('div', { className: 'bt-activity-heat-wrap' },
      h('div', { className: 'bt-activity-section-head' }, h('span', null, copy.sevenDay), h('small', null, copy.activityOnly)),
      h('div', { className: 'bt-activity-heatmap', 'aria-label': copy.sevenDay }, heatmap)),
    h('div', { className: 'bt-activity-toolbar' },
      h(Filter, { label: copy.role, value: filters.role ?? 'all', allLabel: copy.all, options: roles.map(role => ({ value: role.id, label: role.role ? `${role.name} · ${role.role}` : role.name })), onChange: value => onFilter({ ...filters, role: value }) }),
      h(Filter, { label: copy.source, value: filters.source ?? 'all', allLabel: copy.all, options: sourceKeys.map(source => ({ value: source, label: sourceLabel(source, copy) })), onChange: value => onFilter({ ...filters, source: value }) }),
      h(Filter, { label: copy.status, value: filters.status ?? 'all', allLabel: copy.all, options: statuses, onChange: value => onFilter({ ...filters, status: value }) }),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-activity-attention', 'aria-pressed': filters.attention === true, 'data-active': filters.attention || undefined, onClick: () => onFilter({ ...filters, attention: !filters.attention }) }, copy.waitingAttention)),
    body)
}

export async function requestTaskDetail(callImpl, taskId) {
  const value = await callImpl('task-detail', { taskId })
  if (value?.taskId !== taskId) throw new Error('Task detail did not match the selected task')
  return value
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function trapDialogFocus(root) {
  if (!root?.ownerDocument) return () => {}
  const document = root.ownerDocument
  const trigger = document.activeElement
  const focusable = () => [...root.querySelectorAll(FOCUSABLE)]
    .filter(element => element.getAttribute('aria-hidden') !== 'true' && element.closest('[inert]') === null)
  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return
    const items = focusable()
    if (items.length === 0) {
      event.preventDefault()
      if (typeof root.focus === 'function') root.focus()
      return
    }
    const first = items[0]
    const last = items.at(-1)
    const active = document.activeElement
    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !root.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }
  document.addEventListener('keydown', onKeyDown)
  const initial = focusable()[0] ?? root
  if (typeof initial.focus === 'function') initial.focus()
  return () => {
    document.removeEventListener('keydown', onKeyDown)
    if (trigger && trigger.isConnected !== false && typeof trigger.focus === 'function') trigger.focus()
  }
}

export function TeamActivity({ roster, actions, onClose = () => {}, callImpl = apiCall, leaving = false }) {
  const [data, setData] = useState(null)
  const [status, setStatus] = useState('loading')
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [filters, setFilters] = useState({ role: 'all', source: 'all', status: 'all', attention: false })
  const [detail, setDetail] = useState(null)
  const [detailStatus, setDetailStatus] = useState('idle')
  const [detailError, setDetailError] = useState('')
  const detailRef = useRef(null)
  const layerRef = useRef(null)
  useEscape(onClose)
  useEffect(() => trapDialogFocus(layerRef.current), [])
  useEffect(() => {
    let alive = true
    let loaded = false
    let inFlight = false
    const load = () => {
      if (inFlight) return
      inFlight = true
      Promise.resolve().then(() => callImpl('team-activity')).then(value => {
        if (!alive) return
        loaded = true
        setData(value)
        setStatus('ready')
        setError('')
      }).catch(failure => {
        if (!alive) return
        setError(String(failure?.message ?? failure))
        if (!loaded) setStatus('error')
      }).finally(() => { inFlight = false })
    }
    load()
    const timer = setInterval(load, 15_000)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('focus', load)
    }
  }, [callImpl])
  const visibleTasks = data === null ? [] : filterActivityModel(data, filters).tasks
  const selectedTask = visibleTasks.find(task => task.id === selectedId) ?? visibleTasks[0]
  const selectedTaskId = selectedTask?.id ?? null
  const selectedTaskVersion = selectedTask === undefined ? '' : `${selectedTask.sourceStatus}:${selectedTask.evidenceState ?? ''}:${selectedTask.updatedAt ?? ''}`
  useEffect(() => {
    if (selectedTaskId === null) {
      detailRef.current = null
      setDetail(null)
      setDetailStatus('idle')
      setDetailError('')
      return undefined
    }
    let alive = true
    setDetailStatus('loading')
    setDetailError('')
    Promise.resolve().then(() => requestTaskDetail(callImpl, selectedTaskId)).then(value => {
      if (!alive) return
      detailRef.current = value
      setDetail(value)
      setDetailStatus('ready')
    }).catch(failure => {
      if (!alive) return
      setDetailError(String(failure?.message ?? failure))
      setDetailStatus(detailRef.current?.taskId === selectedTaskId ? 'ready' : 'error')
    })
    return () => { alive = false }
  }, [selectedTaskId, selectedTaskVersion, callImpl])
  return h('div', { ref: layerRef, className: 'bt-activity-layer', 'data-leaving': leaving || undefined },
    h('div', { className: 'bt-scrim', onMouseDown: onClose }),
    h(TeamActivityView, { data, roster, status, error, selectedId, filters, detail, detailStatus, detailError, actions, onSelect: setSelectedId, onFilter: setFilters, onClose }))
}

export const TEAM_ACTIVITY_CSS = `
.bt-activity-layer{position:fixed;inset:var(--dsh-frame-chrome-top,0px) 0 0;z-index:60;display:flex;align-items:center;justify-content:center;padding:8px;box-sizing:border-box;font-family:var(--bt-font)}
.bt-activity-layer[data-leaving]{pointer-events:none}
.bt-activity-layer[data-leaving] .bt-scrim{opacity:0;transition:opacity .16s ease-in}
.bt-activity-layer[data-leaving]>[role=dialog]{animation:bt-dialog-sink .16s cubic-bezier(.4,0,1,1) forwards}
.bt-team-activity{position:relative;display:flex;flex-direction:column;width:100%;height:100%;max-width:1600px;min-height:0;border:.5px solid var(--bt-line-2);border-radius:16px;background:var(--bt-main);color:var(--bt-ink);box-shadow:var(--bt-dialog-shadow);overflow:hidden;animation:bt-dialog-rise ${SPRING_SHAPE.duration}ms ${SPRING_SHAPE.easing},bt-veil-in .22s ease-out}
.bt-activity-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:16px 20px 12px;border-bottom:.5px solid var(--bt-line)}
.bt-activity-head h2{margin:0;font-size:15px;line-height:20px;font-weight:600}.bt-activity-head p{margin:4px 0 0;color:var(--bt-ink-2);font-size:12px;line-height:16px}
.bt-activity-head-meta{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}
.bt-activity-mode{font-size:11px;line-height:16px;color:var(--bt-ink-2);border:1px solid var(--bt-line);border-radius:999px;padding:2px 8px;white-space:nowrap}
.bt-activity-mode[data-mode=live]{border-color:color-mix(in srgb,var(--bt-green) 40%,var(--bt-line));color:var(--bt-green)}
.bt-activity-mode[data-partial]{border-color:color-mix(in srgb,var(--bt-star) 40%,var(--bt-line));color:var(--bt-star)}
.bt-activity-mode[data-host-locked]{border-color:color-mix(in srgb,var(--bt-danger) 40%,var(--bt-line));color:var(--bt-danger)}
.bt-activity-close{flex:none}
.bt-activity-stale,.bt-activity-partial-note,.bt-activity-host-read-only{display:flex;gap:8px;align-items:baseline;margin:0;padding:8px 20px;border-bottom:.5px solid var(--bt-line);font-size:12px;line-height:16px}
.bt-activity-stale{background:var(--bt-danger-soft);color:var(--bt-danger)}.bt-activity-stale span{color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-activity-partial-note,.bt-activity-host-read-only{background:var(--bt-tag-bg);color:var(--bt-ink-2)}.bt-activity-host-read-only{color:var(--bt-danger)}
.bt-activity-summary{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;padding:10px 20px;border-bottom:.5px solid var(--bt-line);background:var(--bt-card)}
.bt-activity-summary span{display:flex;align-items:baseline;gap:5px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}.bt-activity-summary b{font-size:22px;line-height:28px;font-weight:600;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-activity-roster-wrap,.bt-activity-heat-wrap{border-bottom:.5px solid var(--bt-line);padding:10px 20px}
.bt-activity-section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-activity-section-head small{font-size:10px;line-height:12px;color:var(--bt-ink-3)}
.bt-activity-roster{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;scrollbar-width:thin}
.bt-activity-role{display:flex;flex:none;align-items:center;gap:8px;min-width:0;padding:4px 8px 4px 4px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card)}
.bt-activity-role[data-main]{border-color:color-mix(in srgb,var(--bt-accent) 38%,var(--bt-line-2))}
.bt-activity-role-copy{display:flex;min-width:0;flex-direction:column;gap:2px}.bt-activity-role-copy b{font-size:12px;line-height:16px;white-space:nowrap}.bt-activity-role-copy small{font-size:11px;line-height:16px;color:var(--bt-ink-3);white-space:nowrap}
.bt-activity-role em{flex:none;font-style:normal;font-size:11px;line-height:16px;color:var(--bt-ink-3);border:1px solid var(--bt-line);border-radius:999px;padding:0 6px}.bt-activity-role[data-main] em{color:var(--bt-accent);border-color:color-mix(in srgb,var(--bt-accent) 38%,var(--bt-line))}
.bt-activity-heatmap{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
.bt-activity-heat-cell{display:flex;flex-direction:column;gap:2px;align-items:center;min-width:0;padding:6px 2px;border-radius:6px;background:color-mix(in srgb,var(--bt-accent) calc(var(--bt-heat,0) * 12%),var(--bt-card));font-size:10px;line-height:12px;color:var(--bt-ink-2)}
.bt-activity-heat-cell b{font-size:13px;line-height:18px;color:var(--bt-ink);font-variant-numeric:tabular-nums}
.bt-activity-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:end;padding:10px 20px;border-bottom:.5px solid var(--bt-line)}
.bt-activity-filter{display:flex;flex-direction:column;gap:4px;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-activity-filter .bt-select{width:170px;min-width:170px;height:34px}
.bt-activity-attention[data-active]{background:var(--bt-accent-soft);color:var(--bt-accent)}
.bt-activity-body{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(220px,.8fr) minmax(190px,.65fr);min-height:0;flex:1;overflow:hidden;animation:bt-veil-in .22s ease-out}
.bt-activity-list{padding:8px;border-right:.5px solid var(--bt-line);overflow:auto;min-width:0}
.bt-activity-task{display:flex;width:100%;align-items:center;gap:8px;padding:8px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-activity-task:hover,.bt-activity-task[data-selected]{background:var(--bt-hover)}
.bt-activity-task:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-2px}
.bt-activity-task-main{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}
.bt-activity-task-title{font-size:12px;line-height:16px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-activity-task-meta,.bt-activity-task-time{font-size:11px;line-height:16px;color:var(--bt-ink-3)}.bt-activity-task-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-activity-task-state{width:max-content;max-width:100%;font-size:11px;line-height:16px;color:var(--bt-ink-2);background:var(--bt-tag-bg);border-radius:999px;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-activity-task-state[data-status=waiting],.bt-activity-status[data-status=waiting]{color:var(--bt-star)}.bt-activity-task-state[data-status=reported],.bt-activity-task-state[data-status=blocked],.bt-activity-task-state[data-status=failed],.bt-activity-task-state[data-status=unknown],.bt-activity-status[data-status=reported],.bt-activity-status[data-status=blocked],.bt-activity-status[data-status=failed],.bt-activity-status[data-status=unknown]{color:var(--bt-danger)}
.bt-activity-task-time{flex:none}
.bt-activity-owner-mark{display:inline-flex;flex:none;align-items:center;justify-content:center;border-radius:999px;background:var(--bt-tag-bg);color:var(--bt-ink-2);font-size:12px;font-weight:600}
.bt-activity-detail{padding:16px;border-right:.5px solid var(--bt-line);overflow:auto;min-width:0}
.bt-activity-detail-head{display:flex;gap:8px;align-items:center;margin-bottom:16px}.bt-activity-detail-head>div{display:flex;min-width:0;flex-direction:column;gap:2px}
.bt-activity-detail-head b{font-size:13px;line-height:18px;overflow-wrap:anywhere}.bt-activity-detail-head span,.bt-activity-detail-head small{font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}.bt-activity-detail-head small[data-main]{color:var(--bt-accent)}
.bt-activity-detail dl{display:flex;flex-direction:column;gap:10px;margin:0}.bt-activity-detail dl>div{display:flex;flex-direction:column;gap:2px}.bt-activity-detail dt{font-size:11px;line-height:16px;color:var(--bt-ink-3)}.bt-activity-detail dd{margin:0;font-size:12px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere}
.bt-task-detail-state{margin:0 0 12px;padding:8px 10px;border-radius:8px;background:var(--bt-tag-bg);font-size:11px;line-height:16px;color:var(--bt-ink-2);overflow-wrap:anywhere}.bt-task-detail-state[role=alert]{background:var(--bt-danger-soft);color:var(--bt-danger)}.bt-task-detail-state span{display:block;margin-top:2px;color:var(--bt-ink-2)}
.bt-task-blockers{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:16px}.bt-task-blockers li[data-kind=owner],.bt-task-blockers li[data-kind=failed-result],.bt-task-blockers li[data-kind=recovery]{color:var(--bt-danger)}
.bt-task-section{margin-top:16px;padding-top:12px;border-top:.5px solid var(--bt-line)}.bt-task-section h4,.bt-trace-head h4{margin:0;font-size:12px;line-height:16px;font-weight:600}
.bt-task-evidence-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}.bt-task-evidence{display:flex;width:100%;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}.bt-task-evidence:hover,.bt-task-evidence[data-selected]{background:var(--bt-hover)}.bt-task-evidence:focus-visible,.bt-trace-tab:focus-visible,.bt-trace-record:focus-visible,.bt-detail-control:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}.bt-task-evidence>span{display:flex;min-width:0;flex-direction:column;gap:2px}.bt-task-evidence b{font-size:12px;line-height:16px;overflow-wrap:anywhere}.bt-task-evidence span span,.bt-task-evidence small{font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}.bt-task-evidence em,.bt-trace-trust{flex:none;font-style:normal;font-size:11px;line-height:16px;color:var(--bt-ink-2);border:1px solid var(--bt-line);border-radius:999px;padding:0 6px}.bt-task-evidence[data-trust=verified] em,.bt-trace-trust[data-trust=verified]{color:var(--bt-green);border-color:color-mix(in srgb,var(--bt-green) 42%,var(--bt-line))}.bt-task-evidence[data-trust=executed] em,.bt-trace-trust[data-trust=executed]{color:var(--bt-accent);border-color:color-mix(in srgb,var(--bt-accent) 42%,var(--bt-line))}.bt-task-evidence[data-trust=reported] em,.bt-trace-trust[data-trust=reported]{color:var(--bt-star)}
.bt-task-artifacts{display:flex;flex-direction:column;gap:6px;margin-top:8px}.bt-task-artifact{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:8px;border:.5px solid var(--bt-line-2);border-radius:8px;background:var(--bt-card)}.bt-task-artifact b{font-size:12px;line-height:16px}.bt-task-artifact span{grid-column:1/-1}.bt-task-artifact small{grid-column:1/-1;font-size:11px;line-height:16px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-trace-explorer{margin-top:16px;padding-top:12px;border-top:.5px solid var(--bt-line)}.bt-trace-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}.bt-trace-head small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt-trace-tabs{display:flex;gap:4px;margin-top:8px;padding:2px;border-radius:8px;background:var(--bt-tag-bg)}.bt-trace-tab{flex:1;border:0;border-radius:6px;padding:5px 7px;background:none;color:var(--bt-ink-2);font:inherit;font-size:11px;line-height:16px;cursor:pointer}.bt-trace-tab[aria-pressed=true]{background:var(--bt-card);color:var(--bt-ink);box-shadow:var(--bt-card-shadow)}
.bt-trace-list,.bt-trace-relations{display:flex;flex-direction:column;gap:4px;margin-top:8px}.bt-trace-record{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:start;gap:4px 8px;width:100%;padding:7px 8px;border:0;border-radius:6px;background:var(--bt-card);color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}.bt-trace-record:hover,.bt-trace-record[data-selected]{background:var(--bt-hover)}.bt-trace-record-main{display:flex;min-width:0;flex-direction:column;gap:2px}.bt-trace-record-main b{font-size:12px;line-height:16px}.bt-trace-record-main span{color:var(--bt-ink-2);font-size:11px;line-height:16px;overflow-wrap:anywhere}.bt-trace-record-main small,.bt-trace-record time{font-size:11px;line-height:16px;color:var(--bt-ink-3)}.bt-trace-record time{white-space:nowrap}.bt-trace-relation{display:flex;gap:8px;padding:6px 8px;border-radius:6px;background:var(--bt-card);font-size:11px;line-height:16px}.bt-trace-relation b{flex:none;color:var(--bt-ink-3)}.bt-trace-relation span{min-width:0;overflow-wrap:anywhere}.bt-trace-note{margin:8px 0 0;font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-detail-controls{display:flex;flex-wrap:wrap;gap:6px;margin-top:16px;padding-top:12px;border-top:.5px solid var(--bt-line)}.bt-detail-control:disabled{opacity:.45;cursor:not-allowed}
.bt-improvement-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.bt-improvement-head h4{margin:0}.bt-improvement-propose:disabled{opacity:.45;cursor:not-allowed}.bt-improvement-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}.bt-improvement-section .bt-learning-card{margin:0}
.bt-activity-status{display:inline-block;font-size:11px;line-height:16px;color:var(--bt-ink-2);background:var(--bt-tag-bg);border-radius:999px;padding:0 6px}
.bt-activity-id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px!important;line-height:16px!important}
.bt-activity-children{display:flex;flex-direction:column;gap:4px;margin:0;padding-left:16px}.bt-activity-warning dd{color:var(--bt-danger)}
.bt-activity-recent{padding:16px;overflow:auto;min-width:0}.bt-activity-recent h3{margin:0 0 8px;font-size:13px;line-height:18px;font-weight:600}
.bt-activity-record{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px;padding:8px 0;border-top:.5px solid var(--bt-line);font-size:12px;line-height:16px}.bt-activity-record b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt-activity-record span{grid-column:1/-1;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt-activity-record[data-kind=blocked] span,.bt-activity-record[data-kind=failed] span{color:var(--bt-danger)}.bt-activity-record time{color:var(--bt-ink-3);font-size:11px;line-height:16px}
.bt-activity-skeleton{display:flex;flex-direction:column;gap:8px;padding:20px;animation:bt-veil-in .22s ease-out}.bt-activity-skeleton span{display:block;height:48px;border-radius:8px;background:var(--bt-tag-bg)}
.bt-activity-empty,.bt-activity-no-task{padding:24px 20px}.bt-activity-detail-empty{padding:16px 12px;color:var(--bt-ink-3);font-size:12px;line-height:16px}.bt-activity-error{margin:0;padding:24px 20px}
@media(max-width:760px){.bt-activity-layer{padding:0}.bt-team-activity{border-width:0;border-radius:0}.bt-activity-body{grid-template-columns:1fr;overflow:auto}.bt-activity-detail,.bt-activity-list{border-right:0;border-bottom:.5px solid var(--bt-line);overflow:visible}.bt-activity-recent{overflow:visible}.bt-activity-head,.bt-activity-roster-wrap,.bt-activity-heat-wrap,.bt-activity-toolbar,.bt-activity-stale,.bt-activity-partial-note,.bt-activity-host-read-only{padding-inline:14px}.bt-activity-head-meta{justify-content:flex-start}.bt-activity-head{gap:10px;flex-wrap:wrap}}
@media(max-width:520px){.bt-activity-summary{grid-template-columns:repeat(2,1fr);gap:6px 1px}.bt-activity-heatmap{gap:4px}.bt-activity-heat-cell{padding:6px 1px}.bt-activity-section-head small{display:none}.bt-activity-filter{flex:1 1 42%}.bt-activity-filter .bt-select{width:100%;min-width:0}}
@media(prefers-reduced-motion:reduce){.bt-team-activity,.bt-activity-layer .bt-scrim,.bt-activity-body,.bt-activity-skeleton{animation:bt-fade .12s ease-out!important}.bt-activity-layer[data-leaving]>[role=dialog],.bt-activity-layer[data-leaving] .bt-scrim{animation:bt-fade .12s ease-out reverse!important;transition:none!important}}
`
