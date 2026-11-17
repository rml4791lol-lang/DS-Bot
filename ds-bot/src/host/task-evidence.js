import { createHash } from 'node:crypto'

const COMMAND_TOOLS = new Set(['bash', 'pwsh'])

const text = value => (value === undefined || value === null ? '' : String(value))

const contentText = (content) => {
  if (!Array.isArray(content)) return ''
  return content.map(block => (typeof block?.text === 'string' ? block.text : '')).filter(Boolean).join('\n')
}

const digest = value => `sha256:${createHash('sha256').update(String(value)).digest('hex')}`

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
}

export const canonicalDigest = value => digest(JSON.stringify(stable(value)))

export const diffDigest = diffs => canonicalDigest((Array.isArray(diffs) ? diffs : []).map(item => ({
  path: text(item?.path),
  oldText: text(item?.oldText),
  newText: text(item?.newText),
})).sort((a, b) => a.path.localeCompare(b.path)))

export class PendingCallCache {
  constructor({ limit = 256 } = {}) {
    this.limit = Number.isInteger(limit) && limit > 0 ? limit : 256
    this.callsBySession = new Map()
    this.count = 0
  }

  get size() {
    return this.count
  }

  remember(sessionId, callId, value) {
    let calls = this.callsBySession.get(sessionId)
    if (calls === undefined) {
      calls = new Map()
      this.callsBySession.set(sessionId, calls)
    }
    if (calls.has(callId)) {
      calls.delete(callId)
      this.count -= 1
    }
    calls.set(callId, value)
    this.count += 1
    while (this.count > this.limit) {
      const [oldestSession, oldestCalls] = this.callsBySession.entries().next().value
      const [oldestCall] = oldestCalls.keys()
      oldestCalls.delete(oldestCall)
      this.count -= 1
      if (oldestCalls.size === 0) this.callsBySession.delete(oldestSession)
    }
  }

  take(sessionId, callId) {
    const calls = this.callsBySession.get(sessionId)
    if (calls === undefined) return undefined
    const value = calls.get(callId)
    if (value === undefined) return undefined
    calls.delete(callId)
    this.count -= 1
    if (calls.size === 0) this.callsBySession.delete(sessionId)
    return value
  }

  clearSession(sessionId) {
    this.count -= this.callsBySession.get(sessionId)?.size ?? 0
    this.callsBySession.delete(sessionId)
  }
}

const commandOf = (argumentsText) => {
  let args = argumentsText
  if (typeof argumentsText === 'string') {
    try {
      args = JSON.parse(argumentsText)
    } catch {
      return undefined
    }
  }
  const command = args?.command ?? args?.cmd ?? args?.script
  return typeof command === 'string' && command.trim() !== '' ? command.trim() : undefined
}

export function noteAttemptRecovery(record, { attemptId, info, sessionId, now = Date.now() } = {}) {
  const kind = info?.resumed === true ? 'resumed' : info?.resent === true ? 'resent' : undefined
  if (!record || typeof record !== 'object' || kind === undefined || attemptId === undefined) return false
  const exchangeId = text(info?.exchangeId)
  const id = `${attemptId}:${kind}:${exchangeId || text(sessionId)}`
  const summary = kind === 'resumed'
    ? 'The same task attempt resumed after the host restarted.'
    : 'The queued handoff was delivered again after the host restarted.'
  record.recovery = [
    ...(Array.isArray(record.recovery) ? record.recovery.filter(item => item?.id !== id) : []),
    { id, at: now, attemptId, kind, summary, ...(text(sessionId) ? { sessionId: text(sessionId) } : {}), ...(exchangeId ? { exchangeId } : {}) },
  ].slice(-16)
  record.attempt = { ...record.attempt, recoveredAt: now }
  return true
}

export function noteRecoveryNeeded(record, { attemptId, sessionId, reason, now = Date.now() } = {}) {
  if (!record || typeof record !== 'object') return false
  const id = `${text(attemptId) || text(sessionId) || 'attempt'}:needs-review`
  record.recovery = [
    ...(Array.isArray(record.recovery) ? record.recovery.filter(item => item?.id !== id) : []),
    {
      id,
      at: now,
      attemptId: text(attemptId) || null,
      kind: 'needs-review',
      summary: reason ?? 'Session events could not be matched to this task attempt after a restart; recover it before accepting the result.',
      ...(text(sessionId) ? { sessionId: text(sessionId) } : {}),
    },
  ].slice(-16)
  return true
}

export function clearRecoveryNeeded(record) {
  if (!Array.isArray(record?.recovery)) return false
  const recovery = record.recovery.filter(item => item?.kind !== 'needs-review')
  if (recovery.length === record.recovery.length) return false
  record.recovery = recovery
  return true
}

export function evidenceFromEvents({ sessionId, actor, events } = {}) {
  const evidence = []
  const calls = new Map()
  for (const event of Array.isArray(events) ? events : []) {
    const seq = Number.isInteger(event?.seq) ? event.seq : evidence.length + 1
    if (event?.type === 'assistant/message') {
      const summary = contentText(event.data?.message?.content)
      if (summary !== '') evidence.push({
        id: `ev:assistant:${text(sessionId)}:${seq}`,
        state: 'reported',
        trust: 'reported',
        kind: 'reported',
        source: 'assistant',
        at: typeof event.time === 'number' ? event.time : null,
        actor,
        summary,
        record: { sessionId, seq },
      })
    } else if (event?.type === 'tool/call') {
      const tool = text(event.data?.name)
      calls.set(text(event.data?.callId), {
        tool,
        arguments: text(event.data?.arguments),
        command: COMMAND_TOOLS.has(tool) ? commandOf(event.data?.arguments) : undefined,
      })
    } else if (event?.type === 'tool/result') {
      const callId = text(event.data?.callId ?? event.data?.message?.toolCallId)
      const call = calls.get(callId)
      if (callId === '' || call === undefined) continue
      const ok = event.data?.message?.ok
        ?? (event.data?.message?.isError === false ? true : event.data?.message?.isError === true ? false : undefined)
      const exitCode = Number.isInteger(event.data?.exitCode) ? event.data.exitCode
        : Number.isInteger(event.data?.message?.exitCode) ? event.data.message.exitCode
          : Number.isInteger(event.data?.meta?.exitCode) ? event.data.meta.exitCode
            : Number.isInteger(event.data?.message?.meta?.exitCode) ? event.data.message.meta.exitCode
          : ok === true ? 0 : ok === false ? 1 : undefined
      const output = contentText(event.data?.message?.content)
      const meta = event.data?.meta ?? event.data?.message?.meta
      const diffs = Array.isArray(meta?.diffs) ? meta.diffs : []
      const diffPaths = [...new Set(diffs.map(item => text(item.path)).filter(Boolean))].sort()
      const hashableDiff = diffs.every(item => typeof item?.path === 'string' && item.path !== ''
        && typeof item.oldText === 'string' && typeof item.newText === 'string')
      evidence.push({
        id: `ev:tool-result:${text(sessionId)}:${callId}`,
        state: 'executed',
        trust: 'executed',
        kind: 'executed',
        source: 'tool-result',
        at: typeof event.time === 'number' ? event.time : null,
        actor,
        summary: output,
        ...(call.command === undefined ? {} : { command: { text: call.command, ...(exitCode === undefined ? {} : { exitCode }), outputDigest: digest(output) } }),
        ...(diffPaths.length === 0 ? {} : { diff: { paths: diffPaths, ...(hashableDiff ? { digest: diffDigest(diffs) } : {}) } }),
        record: { sessionId, seq, callId, tool: call.tool },
      })
    } else if (event?.type === 'deliverables/presented') {
      for (const file of Array.isArray(event.data?.files) ? event.data.files : []) {
        if (typeof file?.path !== 'string' || file.path === '') continue
        evidence.push({
          id: `ev:artifact:${text(sessionId)}:${seq}:${file.path}`,
          state: 'executed',
          trust: 'executed',
          kind: 'executed',
          source: 'deliverable',
          at: typeof event.time === 'number' ? event.time : null,
          actor,
          summary: file.path,
          artifact: { path: file.path, digest: text(file.digest) },
          record: { sessionId, seq, path: file.path },
        })
      }
    }
  }
  return evidence
}

function matchesCheck(check, item) {
  if (item?.state !== 'executed') return false
  if (check.kind === 'command') {
    return item.command?.text === text(check.command ?? check.label).trim()
      && item.command?.exitCode !== undefined
      && (check.expect?.exitCode === undefined || item.command?.exitCode === check.expect.exitCode)
  }
  if (check.kind === 'artifact') {
    return item.artifact?.path === check.path
      && typeof item.artifact?.digest === 'string'
      && item.artifact.digest !== ''
      && (check.expect?.digest === undefined || item.artifact.digest === check.expect.digest)
  }
  if (check.kind === 'diff') {
    return item.diff?.paths?.includes(check.path) === true
      && typeof item.diff?.digest === 'string' && item.diff.digest !== ''
      && (check.expect?.digest === undefined || item.diff.digest === check.expect.digest)
  }
  return false
}

export function verifyAcceptance({ checks = [], evidence = [], now = Date.now() } = {}) {
  const checkEvidence = {}
  const missing = []
  const artifactDigests = {}
  const diffDigests = {}
  const checksOut = []
  const used = new Set()
  for (const check of checks) {
    if (check?.required === false) continue
    const match = evidence.find(item => !used.has(item.id) && matchesCheck(check, item))
    if (match === undefined) {
      missing.push(text(check?.id))
      checksOut.push({ id: text(check?.id), status: 'pending' })
    } else {
      checkEvidence[text(check.id)] = match.id
      used.add(match.id)
      checksOut.push({ id: text(check.id), status: 'verified', evidenceId: match.id })
      if (check.kind === 'artifact') artifactDigests[check.path] = match.artifact.digest
      if (check.kind === 'diff') {
        for (const path of match.diff.paths) diffDigests[path] = match.diff.digest
      }
    }
  }
  return missing.length === 0 && checks.some(check => check?.required !== false)
    ? { state: 'verified', status: 'verified', checkEvidence, evidenceIds: Object.values(checkEvidence), checks: checksOut, verifiedAt: now, missing: [], artifactDigests, diffDigests }
    : { state: 'pending', status: 'pending', checkEvidence, evidenceIds: Object.values(checkEvidence), checks: checksOut, missing }
}

export function invalidateAcceptance(verification, { artifacts = {}, diffs = {} } = {}, now = Date.now()) {
  if (verification?.state !== 'verified') return verification
  const invalidated = [
    ...Object.entries(verification.artifactDigests ?? {}).filter(([path, value]) => Object.hasOwn(artifacts, path) && artifacts[path] !== value).map(([path]) => path),
    ...Object.entries(verification.diffDigests ?? {}).filter(([path, value]) => Object.hasOwn(diffs, path) && diffs[path] !== value).map(([path]) => path),
  ]
  if (invalidated.length === 0) return verification
  return { ...verification, state: 'stale', status: 'stale', invalidatedAt: now, invalidated }
}

export function progressFingerprint(evidence = []) {
  const facts = []
  for (const item of evidence) {
    if (item?.state !== 'executed' && item?.state !== 'verified') continue
    const fact = {
      source: item.source,
      command: item.command === undefined ? undefined : {
        text: item.command.text,
        exitCode: item.command.exitCode,
        outputDigest: item.command.outputDigest,
      },
      artifact: item.artifact === undefined ? undefined : {
        path: item.artifact.path,
        digest: item.artifact.digest,
      },
      diff: item.diff === undefined ? undefined : {
        paths: item.diff.paths,
        digest: item.diff.digest,
      },
    }
    facts.push([canonicalDigest(fact), fact])
  }
  return canonicalDigest(facts.sort(([a], [b]) => a.localeCompare(b)).map(([, fact]) => fact))
}

export function progressAfterTurn(progress, evidence = [], { now = Date.now(), limit = 2 } = {}) {
  const fingerprint = progressFingerprint(evidence)
  const baseline = progress?.lastTurnFingerprint ?? progress?.fingerprint ?? progressFingerprint([])
  const unchanged = baseline === fingerprint
  const unchangedTurns = unchanged ? (progress?.unchangedTurns ?? 0) + 1 : 0
  return {
    state: unchangedTurns >= limit ? 'stalled' : 'moving',
    fingerprint,
    lastTurnFingerprint: fingerprint,
    unchangedTurns,
    ...(unchanged ? {} : { changedAt: now }),
  }
}
