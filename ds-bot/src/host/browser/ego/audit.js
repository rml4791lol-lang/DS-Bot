// Audit is metadata, not pixels. It answers who used which profile on which page
// and what happened, without becoming a second copy of the user's browsing.
import { appendFile, chmod, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { auditUrl } from './policy.js'

export const AUDIT_MAX_BYTES = 1024 * 1024

function safeId(value) {
  return String(value ?? 'unknown').replace(/[^\w.-]/g, '_').slice(0, 100) || 'unknown'
}

function clean(value, limit = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function cleanReason(value, limit = 160) {
  return clean(value, limit).replace(/https?:\/\/[^\s]+/gi, token => auditUrl(token) || '[url]')
}

/**
 * @param {string} home
 * @param {string} botId
 * @param {{ tool: string, action?: string, outcome: string, url?: string, profileId?: string|null, profileName?: string|null, shared?: boolean, target?: string, reason?: string, durationMs?: number }} event
 */
export async function appendAudit(home, botId, event) {
  if (typeof home !== 'string' || home === '') return false
  try {
    const dir = join(home, 'ego-audit')
    await mkdir(dir, { recursive: true })
    const path = join(dir, `${safeId(botId)}.jsonl`)
    try {
      const size = (await stat(path)).size
      if (size >= AUDIT_MAX_BYTES) {
        await rm(`${path}.1`, { force: true })
        await rename(path, `${path}.1`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const line = JSON.stringify({
      ts: Date.now(),
      tool: clean(event.tool, 80),
      action: clean(event.action, 80),
      outcome: clean(event.outcome, 40),
      url: auditUrl(event.url),
      profileId: event.profileId === null || event.profileId === undefined ? null : clean(event.profileId, 100),
      profileName: event.profileName ? clean(event.profileName, 100) : null,
      shared: event.shared === true,
      target: event.target ? clean(event.target, 80) : null,
      reason: event.reason ? cleanReason(event.reason) : null,
      durationMs: typeof event.durationMs === 'number' && Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
    })
    await appendFile(path, `${line}\n`, { mode: 0o600 })
    await chmod(path, 0o600).catch(() => {})
    return true
  } catch {
    // Auditing must never turn a page action into a failure.
    return false
  }
}
