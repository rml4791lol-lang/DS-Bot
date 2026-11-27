// One ego page has one driver at a time. A Bot tool takes a short lease; a user
// pointer or the Bot's handoff takes the page until the user gives it back. Without
// this, the Bot and the user can click the same page at once and neither result is
// reproducible.
export const USER_HOLD_MS = 2 * 60_000
export const BOT_LEASE_MS = 5 * 60_000

export class EgoLease {
  constructor({ now = Date.now, userHoldMs = USER_HOLD_MS, botLeaseMs = BOT_LEASE_MS } = {}) {
    this.now = now
    this.userHoldMs = userHoldMs
    this.botLeaseMs = botLeaseMs
    this.entries = new Map()
  }

  _entry(botId) {
    const entry = this.entries.get(String(botId))
    if (entry === undefined) return undefined
    const age = this.now() - entry.since
    if (entry.owner === 'user') {
      if (entry.until !== null && this.now() >= entry.until) {
        this.entries.delete(String(botId))
        return undefined
      }
      return entry
    }
    if (age >= this.botLeaseMs) {
      this.entries.delete(String(botId))
      return undefined
    }
    return entry
  }

  owner(botId) {
    return this._entry(botId)?.owner ?? null
  }

  detail(botId) {
    const entry = this._entry(botId)
    return entry === undefined ? null : { ...entry }
  }

  beginBot(botId, callId) {
    const current = this._entry(botId)
    if (current?.owner === 'user') return { ok: false, owner: 'user', reason: current.reason ?? null }
    if (current?.owner === 'bot') return { ok: false, owner: 'bot' }
    this.entries.set(String(botId), { owner: 'bot', since: this.now(), callId, reason: null })
    return { ok: true }
  }

  endBot(botId, callId) {
    const current = this.entries.get(String(botId))
    if (current?.owner !== 'bot') return
    if (callId !== undefined && current.callId !== undefined && current.callId !== callId) return
    this.entries.delete(String(botId))
  }

  /** The user always wins: a pointer on the panel is a takeover. */
  takeUser(botId, { reason = null, indefinite = false } = {}) {
    const now = this.now()
    this.entries.set(String(botId), {
      owner: 'user',
      since: now,
      until: indefinite ? null : now + this.userHoldMs,
      callId: undefined,
      reason,
    })
  }

  resume(botId) {
    const current = this.entries.get(String(botId))
    if (current?.owner === 'user') this.entries.delete(String(botId))
  }

  /** The panel is still open and still polling: the user is still there. */
  touchUser(botId) {
    const current = this.entries.get(String(botId))
    if (current?.owner !== 'user' || current.until === null) return
    current.until = this.now() + this.userHoldMs
  }
}
