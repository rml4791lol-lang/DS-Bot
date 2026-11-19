const text = value => (value === undefined || value === null ? '' : String(value))
const timeOf = value => {
  const time = typeof value === 'number' ? value : Date.parse(text(value))
  return Number.isFinite(time) ? time : undefined
}

const defaultRedact = value => text(value)
const trustOf = value => {
  const trust = text(value).toLowerCase()
  return ['reported', 'executed', 'verified'].includes(trust) ? trust : 'reported'
}

function commandView(command, redact) {
  if (!command || typeof command !== 'object') return undefined
  const value = redact(command.text ?? command.command ?? command.label)
  if (value.trim() === '') return undefined
  return {
    text: value,
    ...(Number.isInteger(command.exitCode) ? { exitCode: command.exitCode } : {}),
    ...(text(command.outputDigest) ? { outputDigest: text(command.outputDigest) } : {}),
  }
}

function diffView(diff, redact) {
  if (!diff || typeof diff !== 'object') return undefined
  const paths = [...new Set((Array.isArray(diff.paths) ? diff.paths : []).map(path => redact(path)).filter(Boolean))]
  const digest = text(diff.digest)
  if (paths.length === 0 && digest === '') return undefined
  return { paths, ...(digest ? { digest } : {}) }
}

function artifactView(artifact, redact) {
  if (!artifact || typeof artifact !== 'object' || !text(artifact.path)) return undefined
  const path = redact(artifact.path)
  return {
    path,
    name: redact(artifact.name) || path.split(/[\\/]/).pop(),
    digest: text(artifact.digest) || null,
  }
}

export function normalizeEvidenceItem(item, taskId, index, redact = defaultRedact) {
  if (typeof item === 'string') {
    return { id: `${taskId}:evidence:${index}`, trust: 'reported', text: redact(item), at: null, sourceId: taskId, artifact: null }
  }
  if (!item || typeof item !== 'object') return undefined
  const command = commandView(item.command, redact)
  const diff = diffView(item.diff, redact)
  return {
    id: text(item.id) || `${taskId}:evidence:${index}`,
    trust: trustOf(item.trust ?? item.kind),
    title: redact(item.title),
    ...(text(item.titleKey) ? { titleKey: text(item.titleKey) } : {}),
    ...(text(item.toolName) ? { toolName: text(item.toolName) } : {}),
    ...(text(item.resultKey) ? { resultKey: text(item.resultKey) } : {}),
    text: redact(item.text ?? item.summary),
    ...(text(item.requestDetail) ? { requestDetail: redact(item.requestDetail) } : {}),
    at: timeOf(item.at ?? item.time) ?? null,
    sourceId: text(item.sourceId ?? item.source) || taskId,
    artifact: artifactView(item.artifact, redact) ?? null,
    ...(command ? { command } : {}),
    ...(diff ? { diff } : {}),
    stale: item.stale === true,
  }
}

export function evidenceForRecord(raw, taskId, redact = defaultRedact) {
  const evidence = []
  if (raw?.stage?.evidence) {
    evidence.push({
      id: `goal:${text(raw.goal?.id)}:${text(raw.stage?.id)}:stage-evidence`,
      trust: 'reported',
      title: '',
      text: redact(raw.stage.evidence),
      at: timeOf(raw.stage.passedAt) ?? null,
      sourceId: `goal:${text(raw.goal?.id)}:${text(raw.stage?.id)}`,
      artifact: null,
    })
  }
  const declared = raw?.task?.evidence ?? raw?.work?.evidence
  if (Array.isArray(declared)) {
    for (const [index, item] of declared.entries()) {
      const normalized = normalizeEvidenceItem(item, taskId, index, redact)
      if (normalized !== undefined) evidence.push(normalized)
    }
  } else if (typeof declared === 'string' && declared !== '') {
    evidence.push(normalizeEvidenceItem(declared, taskId, 0, redact))
  }
  return evidence
}

export function normalizeEvidenceTrust(evidence, verification) {
  const ids = new Set((Array.isArray(verification?.evidenceIds) ? verification.evidenceIds : []).map(text))
  const verifiedAt = timeOf(verification?.verifiedAt)
  const downgradeVerified = verification?.status === 'stale'
  return (Array.isArray(evidence) ? evidence : []).map(item => {
    if (item?.trust !== 'verified') return item
    const bound = !downgradeVerified
      && ids.has(text(item.id))
      && item.stale !== true
      && (verifiedAt === undefined || timeOf(item.at) === undefined || timeOf(item.at) <= verifiedAt)
    return bound ? item : { ...item, trust: 'reported' }
  })
}

function evidenceStateOf(task, evidence, status) {
  if (status === 'stale' || status === 'needs-review' || status === 'verified') return status
  if (task?.status === 'reported' || task?.status === 'done') return 'reported'
  if (evidence.some(item => item?.trust === 'executed' && item.stale !== true)) return 'executed'
  if (evidence.some(item => item?.trust === 'reported' || item?.trust === 'requested')) return 'reported'
  return 'pending'
}

export function projectTaskVerification(raw, evidence = []) {
  const declared = raw?.task?.verification ?? raw?.work?.verification
  let status = 'pending'
  let reason = 'No fresh acceptance verification is attached to this task.'
  if (declared && typeof declared === 'object') {
    const ids = new Set((Array.isArray(declared.evidenceIds) ? declared.evidenceIds : []).map(text))
    const verifiedAt = timeOf(declared.verifiedAt)
    const bound = evidence.filter(item => ids.has(text(item?.id))
      && item?.trust === 'verified'
      && item?.stale !== true
      && (verifiedAt === undefined || timeOf(item.at) === undefined || timeOf(item.at) <= verifiedAt))
    const checks = Array.isArray(declared.checks) ? declared.checks : []
    const checksPass = checks.every(check => check?.status === 'verified'
      && (check.evidenceId === undefined || bound.some(item => text(item.id) === text(check.evidenceId))))
    const declaredStatus = declared.status ?? declared.state
    if (declaredStatus === 'stale') {
      status = 'stale'
      reason = text(declared.reason) || 'The verified artifact changed after acceptance.'
    } else if (declaredStatus === 'needs-review') {
      status = 'needs-review'
      reason = text(declared.reason) || 'The task needs review before acceptance.'
    } else if (declaredStatus === 'verified' && bound.length > 0 && checksPass && declared.fresh !== false) {
      status = 'verified'
      reason = text(declared.reason) || 'All declared acceptance checks are bound to fresh evidence.'
    } else {
      reason = text(declared.reason) || 'Acceptance verification is not bound to fresh evidence.'
    }
  }
  const verification = {
    status,
    reason,
    ...(declared && Array.isArray(declared.evidenceIds) ? { evidenceIds: declared.evidenceIds.map(text) } : {}),
    ...(declared && timeOf(declared.verifiedAt) !== undefined ? { verifiedAt: timeOf(declared.verifiedAt) } : {}),
  }
  const normalized = normalizeEvidenceTrust(evidence, declared ? { ...declared, status } : verification)
  return {
    evidence: normalized,
    verification,
    evidenceState: evidenceStateOf(raw?.task ?? raw?.work, normalized, status),
  }
}
