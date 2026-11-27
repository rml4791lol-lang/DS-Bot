// ego profiles hold the login state. A Bot's profile is found by a stable Bot id,
// never by the Bot's display name: renaming a Bot must not silently move it to a
// different login. A missing profile is an error, not an invitation to use the
// user's default profile.
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PROFILE_MAP_FILE = 'ego-profiles.json'

function mapPath(home) {
  return join(home, PROFILE_MAP_FILE)
}

function parseMap(text) {
  try {
    const value = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

/** Used by the panel, which cannot wait for disk I/O before choosing a profile. */
export function readProfileMapSync(home) {
  if (typeof home !== 'string' || home === '') return {}
  try {
    return parseMap(readFileSync(mapPath(home), 'utf8'))
  } catch {
    return {}
  }
}

async function writeMap(home, map) {
  await mkdir(home, { recursive: true })
  const path = mapPath(home)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600).catch(() => {})
  await rename(temp, path)
}

const queues = new Map()

// One read-modify-write at a time per home. Two Bots finishing their first page at
// the same moment must not erase each other's mapping.
function withLock(home, work) {
  const key = String(home)
  const previous = queues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(work)
  queues.set(key, next)
  return next.finally(() => {
    if (queues.get(key) === next) queues.delete(key)
  })
}

export class EgoProfiles {
  constructor({ home } = {}) {
    this.home = home
  }

  async read() {
    if (typeof this.home !== 'string' || this.home === '') return {}
    try {
      return parseMap(await readFile(mapPath(this.home), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return {}
      throw error
    }
  }

  async get(botId) {
    const entry = (await this.read())[String(botId)]
    return entry !== null && typeof entry === 'object' ? entry : undefined
  }

  async remember(botId, { profileId, profileName }) {
    if (profileId === undefined || profileId === null) return
    return withLock(this.home, async () => {
      const map = await this.read()
      map[String(botId)] = {
        profileId: String(profileId),
        profileName: String(profileName ?? ''),
        updatedAt: Date.now(),
      }
      await writeMap(this.home, map)
    })
  }

  async forget(botId) {
    return withLock(this.home, async () => {
      const map = await this.read()
      if (map[String(botId)] === undefined) return
      delete map[String(botId)]
      await writeMap(this.home, map)
    })
  }
}

/**
 * The profile a Bot asks for. `browserEgoProfile` is an explicit profile name from
 * the Bot settings; otherwise the Bot's name is only a label for a new profile.
 */
export function requestedProfileName(bot) {
  const explicit = typeof bot?.browserEgoProfile === 'string' ? bot.browserEgoProfile.trim() : ''
  if (explicit) return explicit
  return `Anbot · ${bot?.name ?? 'Bot'}`
}

/**
 * Reuse the stored id only while the Bot still asks for the same profile name.
 * Changing the setting to another name is a deliberate move to another login.
 */
export function storedProfileId(stored, profileName) {
  if (stored === undefined || stored.profileId === undefined) return undefined
  if (String(stored.profileName ?? '') !== String(profileName ?? '')) return undefined
  return String(stored.profileId)
}

/**
 * Renaming a Bot must not change its login. Once a profile is linked, the stored
 * profile wins over the Bot's current display name; an explicit setting still wins
 * over the stored profile so the user can deliberately move the Bot.
 */
export function profileForBot(bot, stored) {
  const explicit = typeof bot?.browserEgoProfile === 'string' ? bot.browserEgoProfile.trim() : ''
  if (explicit) return { profileName: explicit, profileId: storedProfileId(stored, explicit) }
  if (stored !== undefined && stored.profileId !== undefined && stored.profileName) {
    return { profileName: String(stored.profileName), profileId: String(stored.profileId) }
  }
  return { profileName: requestedProfileName(bot), profileId: undefined }
}

/**
 * A default profile name belongs to one Bot. A new Bot with a recycled display name
 * must not inherit the old Bot's login by accident; sharing needs the explicit
 * `browserEgoProfile` setting, which the user makes and the audit marks as shared.
 */
export function linkedToOtherBot(map, profileName, botId) {
  for (const [id, entry] of Object.entries(map ?? {})) {
    if (String(id) === String(botId)) continue
    if (String(entry?.profileName ?? '') === String(profileName ?? '')) return String(id)
  }
  return undefined
}
