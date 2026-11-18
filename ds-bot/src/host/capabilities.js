import { createHash } from 'node:crypto'
import { encodeUrlComponent } from './secrets.js'
import { own } from './store.js'
import { catalogEntries, catalogSignature, validateShortlistAgainstCatalog } from './skill-catalog.js'
import { readSkillShortlist, SKILL_PURPOSE_MAX } from './skill-shortlist.js'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g
const ENSURE_TIMEOUT_MS = 15_000
const SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/

// DSH injects a directly invoked skill's body from its own `agent/pre-step`
// listener. Denying the `skill` tool does not cover that path, so a strict mask
// failure must reject a step that carries such a gesture until reconciliation
// succeeds. Ordinary messages still run without skill access.
export function skillMaskPreStepGate(unavailable) {
  return async function rejectUnavailableSkillGestures({ agent, messages }, next) {
    if (!unavailable.has(agent)) return next()
    const invokesSkill = (Array.isArray(messages) ? messages : []).some(message =>
      message?.source?.kind === 'user'
      && Array.isArray(message.content)
      && message.content.some(block => block?.type === 'text'
        && typeof block.text === 'string'
        && SKILL_GESTURE.test(block.text)))
    return invokesSkill ? { kind: 'reject' } : next()
  }
}

// Connector ids are reserved: a capability named like one would collide with
// its mcp__<id>__* tool prefix. The connectors module registers its ids here.
export const CONNECTOR_IDS = new Set(['github', 'mail'])
export function validateCapabilityName(value, reserved = CONNECTOR_IDS) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github' || reserved.has(name)) {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; connector names are reserved.')
  }
  return name
}

export function expandCapabilityNames(capabilities, library) {
  const expanded = new Set()
  for (const name of capabilities ?? []) {
    const item = own(library, name)
    if (!item) throw new Error(`No capability named ${name}.`)
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = own(library, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
    } else if (item.kind === 'mcp' || item.kind === 'skill') {
      expanded.add(name)
    } else {
      throw new Error(`Capability ${name} has an unknown kind.`)
    }
  }
  return expanded
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const strings = value => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('Arguments must be a list of text values.')
  return [...value]
}
const stringMap = (value, label) => {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error(`${label} must contain text values.`)
  return Object.fromEntries(Object.entries(value))
}

export function install(rt) {
  const { ctx, state } = rt
  const agents = new Map()
  // Mounted fibers live in each Agent's own context, so they outlive this plugin unless
  // its cleanup disposes them; a strong map keeps them reachable for that.
  const mounts = new Map()
  // One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
  const chains = new WeakMap()
  const queued = new WeakSet()
  const sessionStatuses = new Map()
  let pluginPromise
  let scheduled = null
  let loadingSecrets = 0
  let stopped = false
  // Mask fibers per Agent: profile skills hidden by a Bot's shortlist.
  const skillMasks = new Map()
  const skillMaskUnavailable = new Map()
  let masking = 0
  let skillChangePending = false
  let catalogCache = []
  // The last Agent that could read the profile catalog, reused so a catalog
  // refresh does not load a Session it already has.
  let profileAgentRef

  const library = () => state.capabilities.items
  const ensureLibrary = () => {
    state.capabilities ??= { items: {} }
    state.capabilities.items ??= {}
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const allowedToEdit = (item, botId) => rt.isMain(botId) || item.createdBy === botId
  const usedByOthers = (name, botId) => Object.values(state.bots).some(bot => bot.id !== botId
    && (bot.capabilities ?? []).some((attached) => {
      const item = own(library(), attached)
      return attached === name || (item?.kind === 'pack' && (item.items ?? []).includes(name))
    })
    || (own(library(), name)?.kind === 'skill'
      && (bot.skillShortlist ?? []).some(skill => skill.name === name)))
  const skillItems = () => Object.values(library()).filter(item => item?.kind === 'skill' && typeof item.name === 'string')
  // DSH's catalog is a merge over providers and follows symbolic links; never a
  // directory scan. An Agent's own scope is the only place masks are registered.
  const skillCwd = ({ agent, botId } = {}) => {
    try {
      return agent?.session?.header?.cwd
        ?? (botId === undefined ? undefined : rt.workDirOf?.({ botId }))
        ?? rt.teamFolder?.()
        ?? process.cwd()
    } catch {
      // A host without its workspace services still has a process folder.
      return process.cwd()
    }
  }
  // The scoped skill registry reaches the host only through an Agent's own
  // context on some hosts. One probe decides whether a profile catalog is
  // reachable at all, so validation never mistakes "unreachable" for "missing".
  const isSkillService = service => typeof service?.list === 'function' || typeof service?.snapshot === 'function'
  const skillService = (agent) => {
    let service
    try { service = agent?.ctx?.skills } catch { /* the caller has no skill scope */ }
    if (!isSkillService(service)) {
      try { service = ctx.skills } catch { /* this context did not inject the registry */ }
    }
    if (!isSkillService(service)) service = ctx.get?.('skills')
    return isSkillService(service) ? service : undefined
  }
  // A Bot's own Agent is the scope that carries the profile catalog, and the
  // host side saves shortlists without ever holding that Agent.
  const skillAgentOf = async (botId) => {
    if (botId === undefined) return undefined
    const bot = state.bots?.[botId]
    if (bot === undefined) return undefined
    try { return await rt.resolveAgent(bot.sessionId) } catch { return undefined }
  }
  const liveAgentOf = (sessionId) => {
    try { return agents.get(sessionId)?.deref?.() } catch { return undefined }
  }
  const listProfileSkills = async ({ agent, cwd, strict = false } = {}) => {
    // `agent.ctx.skills` is the scoped view. A host without that service (for
    // example an older embedder or a focused unit test) simply has no profile
    // catalog; reading through `ctx.get` avoids Cordis' inject guard.
    const service = skillService(agent)
    if (service === undefined) return []
    if (strict && typeof service.snapshot !== 'function') throw new Error('This DSH cannot verify the skill catalog.')
    const options = { cwd, ...(agent === undefined ? {} : { scope: agent }) }
    try {
      if (typeof service.snapshot === 'function') {
        const snapshot = await service.snapshot(options)
        if (strict && snapshot?.complete !== true) throw new Error('The skill catalog is incomplete.')
        if (Array.isArray(snapshot?.skills)) return snapshot.skills
      }
      return typeof service.list === 'function' ? await service.list(options) : []
    } catch (error) {
      if (agent === undefined || strict) throw error
      // A scope that cannot be read falls back to the profile view rather than
      // hiding the whole catalog from validation.
      if (typeof service.snapshot === 'function') {
        try {
          const snapshot = await service.snapshot({ cwd })
          if (Array.isArray(snapshot?.skills)) return snapshot.skills
        } catch { /* fall through to list */ }
      }
      return typeof service.list === 'function' ? service.list({ cwd }) : []
    }
  }
  const buildCatalog = async (options = {}) => catalogEntries(
    await listProfileSkills({ agent: options.agent, cwd: options.cwd ?? skillCwd(options), strict: options.strict === true }),
    skillItems(),
    { includeMasked: options.includeMasked === true, strict: options.strict === true },
  )
  async function refreshSkillCatalog({ publish = true } = {}) {
    const before = catalogSignature(catalogCache)
    try {
      const bots = Object.values(state.bots ?? {})
      // One scoped read per Agent: a Bot's mask removes names from its own view
      // only, so the picker mirrors what each Agent can actually run. An idle
      // Bot still needs the profile names, and reading them through a live or
      // resolved sibling Agent is the only scoped path the host has.
      const byScope = new Map()
      const merged = new Map()
      const readAt = async (agent, cwd) => {
        const key = `${agent?.session?.id ?? 'host'}:${cwd}`
        if (!byScope.has(key)) byScope.set(key, await buildCatalog({ agent, cwd }))
        return byScope.get(key)
      }
      if (bots.length === 0) {
        catalogCache = await readAt(undefined, skillCwd({}))
      } else {
        // Never load a Session just to read the catalog: a team of idle Bots must
        // not wake up for a picker refresh. The first live Agent (or the one a
        // save already resolved) reads for the Bots that are not running yet.
        let sibling = profileAgentRef?.deref?.()
        if (sibling === undefined) {
          for (const bot of bots) {
            sibling = liveAgentOf(bot.sessionId)
            if (sibling !== undefined) break
          }
        }
        for (const bot of bots) {
          for (const skill of await readAt(liveAgentOf(bot.sessionId) ?? sibling, skillCwd({ botId: bot.id }))) {
            const previous = merged.get(skill.name)
            const variant = { ...skill }
            if (previous === undefined) {
              merged.set(skill.name, { ...variant, bots: [bot.id], byBot: { [bot.id]: variant } })
            } else {
              if (!previous.bots.includes(bot.id)) previous.bots.push(bot.id)
              previous.byBot[bot.id] = variant
            }
          }
        }
        catalogCache = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
      }
    } catch (error) {
      rt.warn('ds-bot: skill catalog could not be read: %s', error)
    }
    // Do not make every save look like a catalog change. The live key is only
    // useful when the catalog actually moved (install, remove, rename, or scope).
    if (publish && catalogSignature(catalogCache) !== before) rt.publishFeed?.('live', {})
    return catalogCache
  }
  // Validation and masking read the same view, so a name the picker shows is a
  // name the host accepts and a name the picker omits is a name execution hides.
  // The client filters `bots` for its Bot; a no-id caller still sees the union.
  rt.skillCatalogView = botId => botId === undefined
    ? catalogCache
    : catalogCache
      .filter(skill => !Array.isArray(skill.bots) || skill.bots.includes(botId))
      .map(skill => skill.byBot?.[botId] === undefined ? skill : { ...skill, ...skill.byBot[botId] })
  rt.skillCatalogSignature = () => catalogSignature(catalogCache)
  rt.refreshSkillCatalog = refreshSkillCatalog
  rt.validateSkillShortlist = async (list, options = {}) => {
    if (list === undefined) return undefined
    // A save from the host side holds no Agent, and the profile catalog is only
    // reachable through one. Read the Bot's own scope before deciding a name is
    // missing; when no scope can be reached at all, keep the shape rules and
    // accept the names rather than rejecting every real skill.
    const agent = options.agent ?? await skillAgentOf(options.botId)
    if (skillService(agent) === undefined) return readSkillShortlist(list)
    if (agent !== undefined) profileAgentRef = new WeakRef(agent)
    const catalog = await buildCatalog({ ...options, agent })
    return validateShortlistAgainstCatalog(list, catalog)
  }
  // Hide every profile skill this Bot did not choose. Registration goes through a
  // plugin mounted in the Agent's own context, so the mask lands in the Agent layer
  // and outranks the global profile entry; copied SKILL.md text would not.
  async function applySkillMasks(agent, bot, mountedSkills = new Set()) {
    if (!agent?.ctx) return
    const current = skillMasks.get(agent)
    const hide = new Map()
    if (Array.isArray(bot?.skillShortlist)) {
      const chosen = new Set(bot.skillShortlist.map(skill => skill.name))
      const profile = catalogEntries(
        await listProfileSkills({ agent, botId: bot.id, cwd: skillCwd({ agent, botId: bot.id }), strict: true }),
        [],
        { includeMasked: true },
      )
      const capabilities = new Set(skillItems().map(skill => skill.name))
      for (const skill of profile) {
        // A chosen name is only exempt when it is a profile skill, or when a
        // same-name DS-Bot capability actually mounted. If that mount failed,
        // keep the profile skill masked instead of silently falling back.
        if (!chosen.has(skill.name) || (capabilities.has(skill.name) && !mountedSkills.has(skill.name))) {
          hide.set(skill.name, skill)
        }
      }
    }
    // One plugin registers the whole mask set. A profile with 100+ skills used
    // to create one fiber per hidden name; one scoped plugin is enough because
    // all registrations land in the same Agent layer.
    const key = [...hide].map(([name, skill]) => `${name}\0${skill.description}`).join('\n')
    if (current?.key === key) return
    masking += 1
    try {
      if (current?.fiber) {
        try { await current.fiber.dispose?.() } catch { /* the Agent may already be gone */ }
      }
      if (hide.size === 0) {
        skillMasks.delete(agent)
        return
      }
      const plugin = {
        name: 'ds-bot-skill-mask',
        inject: ['skills'],
        apply(c) {
          c.effect(() => {
            const disposers = []
            for (const [name, skill] of hide) {
              disposers.push(c.skills.register({
                name,
                description: skill.description || `Skill hidden by ${bot.name}'s shortlist`,
                source: 'shortlist-mask',
                content: '',
                invocation: { modelInvocable: false, userInvocable: false },
              }))
            }
            return () => { for (const dispose of disposers.reverse()) dispose?.() }
          })
        },
      }
      const fiber = agent.ctx.plugin(plugin)
      await fiber?.await?.()
      skillMasks.set(agent, { key, fiber })
    } finally {
      masking -= 1
      if (masking === 0 && skillChangePending) {
        skillChangePending = false
        catalogChanged()
      }
    }
  }
  rt.applySkillMasks = applySkillMasks
  // If a strict scoped snapshot cannot be applied, do not leave the DSH
  // `skill` loader as a fail-open path. The catalog and loader are connected
  // through this tool, so hiding it retires the model-facing skill surface
  // until a later catalog change can reconcile successfully.
  const setSkillUnavailable = (agent, unavailable) => {
    if (unavailable) {
      if (skillMaskUnavailable.has(agent)) return
      let dispose
      try {
        dispose = agent.ctx?.tools?.restrict?.({ deny: ['skill'] })
      } catch (error) {
        rt.warn('ds-bot: could not disable the skill loader for %s: %s', agent.session?.id, error)
      }
      // Keep the gate armed even when this DSH has no tool restriction API.
      skillMaskUnavailable.set(agent, typeof dispose === 'function' ? dispose : null)
      return
    }
    if (skillMaskUnavailable.has(agent)) {
      const current = skillMaskUnavailable.get(agent)
      try { current() } catch { /* the Agent may already be gone */ }
      skillMaskUnavailable.delete(agent)
    }
  }
  // A creator that is not a Main Bot could otherwise rewrite what a Main Bot runs.
  const editCheck = (item, botId, verb) => {
    if (!allowedToEdit(item, botId)) throw new Error(`Only ${item.createdBy ? 'its creator or a Main Bot' : 'a Main Bot'} can ${verb} ${item.name}.`)
    if (!rt.isMain(botId) && usedByOthers(item.name, botId)) throw new Error(`Another Bot uses ${item.name}, so only a Main Bot can ${verb} it.`)
  }
  const itemInput = (body, { botId, ui }) => {
    const name = validateCapabilityName(body.name)
    const kind = body.kind
    if (!['mcp', 'skill', 'pack'].includes(kind)) throw new Error('Choose an MCP server, skill, or pack.')
    const items = ensureLibrary()
    const previous = own(items, name)
    if (previous && !ui) editCheck(previous, botId, 'change')
    if (previous && previous.kind !== kind) throw new Error('A capability cannot change its kind. Delete it and save a new one.')
    const now = Date.now()
    const item = {
      name,
      kind,
      description: String(body.description ?? '').trim().slice(0, 2000),
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
    if (kind === 'mcp') {
      const transport = body.transport === 'streamable-http' ? 'streamable-http' : 'stdio'
      if (transport === 'stdio') {
        const command = String(body.command ?? '').trim()
        if (command === '') throw new Error('Enter a command for the MCP server.')
        const args = strings(body.args)
        const env = stringMap(body.env, 'Environment variables')
        const changed = !previous || previous.kind !== 'mcp' || previous.transport !== 'stdio'
          || previous.command !== command || !same(previous.args ?? [], args) || !same(previous.env ?? {}, env)
        Object.assign(item, { transport, command, args, env, approved: ui ? true : changed ? false : previous.approved === true })
      } else {
        const url = String(body.url ?? '').trim()
        try {
          const parsed = new URL(url)
          if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error()
        } catch { throw new Error('Enter a valid HTTP or HTTPS URL.') }
        Object.assign(item, { transport, url, headers: stringMap(body.headers, 'Headers'), approved: true })
      }
    } else if (kind === 'skill') {
      item.content = String(body.content ?? '').trim()
    } else {
      const names = [...new Set(strings(body.items))]
      for (const childName of names) {
        const child = own(items, childName)
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Packs can include only saved MCP servers and skills. ${childName} is not one.`)
      }
      item.items = names
    }
    items[name] = item
    return item
  }
  const capabilitySave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const item = itemInput(body ?? {}, options)
    await rt.save()
    return item
  }
  const capabilityDelete = async (name, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    const item = own(items, String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    if (!ui) editCheck(item, botId, 'delete')
    delete items[item.name]
    for (const pack of Object.values(items)) if (pack.kind === 'pack') pack.items = (pack.items ?? []).filter(child => child !== item.name)
    for (const bot of Object.values(state.bots)) bot.capabilities = (bot.capabilities ?? []).filter(attached => attached !== item.name)
    await rt.save()
    return true
  }
  // Called with the Bot being deleted, after it left the team. The shared list belongs to
  // the user, so only a local MCP this Bot added, nobody approved and no other Bot or pack
  // uses goes: no one is left to ask for it, and approving it would start a server for no one.
  // Anything a pack lists stays.
  const dropOrphanCapabilities = (bot) => {
    const items = library()
    const packed = name => Object.values(items).some(item => item.kind === 'pack' && (item.items ?? []).includes(name))
    for (const name of bot.capabilities ?? []) {
      const item = own(items, name)
      if (item === undefined || item.kind !== 'mcp' || item.transport !== 'stdio' || item.approved === true) continue
      if (item.createdBy !== bot.id || usedByOthers(name, bot.id) || packed(name)) continue
      delete items[item.name]
    }
  }
  const changeAttachment = async (endpoint, { name, bot: targetRef }, callerId) => {
    await rt.load()
    writeCheck()
    const caller = rt.botOf(callerId)
    if (!caller) throw new Error('Only Bots on the team can change capabilities.')
    const target = targetRef ? rt.findBot(targetRef) : caller
    if (!target) throw new Error(`No Bot named ${targetRef}.`)
    if (target.id !== caller.id && !rt.isMain(callerId)) throw new Error('Only a Main Bot can change another Bot’s capabilities.')
    const item = own(ensureLibrary(), String(name ?? ''))
    if (!item) throw new Error(`No capability named ${name}.`)
    await setAttached(target, item.name, endpoint === 'attach')
    return { bot: target.name, attached: endpoint === 'attach' }
  }
  // Changes one name against the saved list, so two quick changes both land.
  const shortlistPurpose = item => {
    const text = String(item.description || item.name).replace(/\s+/g, ' ').trim()
    return text.length <= SKILL_PURPOSE_MAX ? text : `${text.slice(0, SKILL_PURPOSE_MAX - 3)}...`
  }
  const setAttached = async (bot, name, attached) => {
    const item = own(library(), name)
    const capabilities = [...(bot.capabilities ?? [])]
    const wasEmpty = capabilities.length === 0
    if (attached && !capabilities.includes(name)) capabilities.push(name)
    if (!attached) {
      const index = capabilities.indexOf(name)
      if (index >= 0) capabilities.splice(index, 1)
    }
    let shortlist = bot.skillShortlist
    let shortlistChanged = false
    if (item?.kind === 'skill' && Array.isArray(shortlist)) {
      shortlist = [...shortlist]
      const selected = shortlist.findIndex(skill => skill.name === name)
      if (attached && selected < 0) {
        shortlist.push({ name, purpose: shortlistPurpose(item) })
        shortlistChanged = true
      }
      if (!attached && selected >= 0) {
        shortlist.splice(selected, 1)
        shortlistChanged = true
      }
      // Capabilities are another editing surface for the same five-item
      // shortlist. Validate before assigning or saving, so a sixth attach is
      // rejected without leaving a half-applied attachment.
      shortlist = readSkillShortlist(shortlist)
    }
    bot.capabilities = capabilities
    if (shortlist !== undefined) bot.skillShortlist = shortlist
    await rt.save()
    if ((wasEmpty && bot.capabilities.length > 0) || shortlistChanged) {
      await trackBotAgents(bot)
      void scheduleReconcile()
    }
    return bot.capabilities
  }

  const statusSet = (botId, itemName, sessionId, status) => {
    let byItem = sessionStatuses.get(botId)
    if (!byItem) sessionStatuses.set(botId, byItem = new Map())
    let bySession = byItem.get(itemName)
    if (!bySession) byItem.set(itemName, bySession = new Map())
    bySession.set(sessionId, status)
  }
  const clearStatus = (botId, itemName, sessionId) => {
    const byItem = sessionStatuses.get(botId)
    const bySession = byItem?.get(itemName)
    bySession?.delete(sessionId)
    if (bySession?.size === 0) byItem.delete(itemName)
    if (byItem?.size === 0) sessionStatuses.delete(botId)
  }
  const clearSession = sessionId => {
    for (const [botId, byItem] of sessionStatuses) {
      for (const [name, bySession] of byItem) {
        bySession.delete(sessionId)
        if (bySession.size === 0) byItem.delete(name)
      }
      if (byItem.size === 0) sessionStatuses.delete(botId)
    }
  }
  const statusFor = (botId, name) => {
    const values = [...(sessionStatuses.get(botId)?.get(name)?.values() ?? [])]
    if (values.some(status => status.state === 'error')) return values.find(status => status.state === 'error')
    if (values.some(status => status.state === 'needs-approval')) return { state: 'needs-approval' }
    if (values.some(status => status.state === 'connecting')) return { state: 'connecting' }
    return values.length > 0 ? { state: 'ready' } : undefined
  }
  const capabilityStatusesView = () => {
    const result = {}
    for (const bot of Object.values(state.bots)) {
      const statuses = {}
      const names = new Set(bot.capabilities ?? [])
      // A shortlisted DS-Bot skill is effective even though it is not a
      // manual attachment. Show its real mount status and ownership.
      for (const skill of bot.skillShortlist ?? []) {
        if (own(library(), skill.name)?.kind === 'skill') names.add(skill.name)
      }
      for (const name of names) {
        const item = own(library(), name)
        if (!item) continue
        if (item.kind !== 'pack') {
          const status = statusFor(bot.id, name)
          if (status) statuses[name] = status
          continue
        }
        const expected = (item.items ?? []).length
        const children = (item.items ?? []).map(child => statusFor(bot.id, child)).filter(Boolean)
        const error = children.find(status => status.state === 'error')
        if (error) {
          statuses[name] = error
          continue
        }
        const approval = children.find(status => status.state === 'needs-approval')
        if (approval) {
          statuses[name] = approval
          continue
        }
        if (children.length > 0 && children.length < expected) {
          statuses[name] = { state: 'partial' }
          continue
        }
        const status = children.find(status => status.state === 'connecting') ?? children[0]
        if (status) statuses[name] = status
      }
      result[bot.id] = statuses
    }
    return result
  }
  const libraryView = () => Object.values(library()).map(item => ({
    ...item,
    ...(item.env ? { env: { ...item.env } } : {}),
    ...(item.headers ? { headers: { ...item.headers } } : {}),
    ...(item.items ? { items: [...item.items] } : {}),
  }))

  async function loadMcpPlugin() {
    if (!pluginPromise) {
      pluginPromise = (async () => {
        const loader = ctx.get?.('loader')
        if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
        const exports = await loader.import(MCP_CLIENT)
        return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
      })()
    }
    return pluginPromise
  }
  function secretFor(name, botId) {
    const value = rt.canUseSecret(name, botId) ? rt.secretValue(name) : undefined
    if (value === undefined) throw new Error(`Secret ${name} is missing or unavailable for this Bot.`)
    return value
  }
  function resolveValues(values, botId) {
    const resolved = {}
    for (const [key, raw] of Object.entries(values ?? {})) {
      resolved[key] = String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId))
    }
    return resolved
  }
  const resolveUrl = (url, botId) => String(url).replace(SECRET_REFERENCE, (_match, name) => encodeUrlComponent(secretFor(name, botId)))
  const resolveList = (list, botId) => (list ?? []).map(raw => String(raw).replace(SECRET_REFERENCE, (_match, name) => secretFor(name, botId)))
  const configFor = (item, botId) => {
    if (item.kind === 'skill') return { name: item.name, description: item.description, content: item.content, provider: 'ds-bot' }
    if (item.transport === 'stdio') return { transport: 'stdio', serverName: item.name, command: item.command, args: resolveList(item.args, botId), env: resolveValues(item.env, botId), failOnStartupError: true }
    return { transport: 'streamable-http', serverName: item.name, url: resolveUrl(item.url, botId), headers: resolveValues(item.headers, botId), failOnStartupError: true }
  }
  const disposeMount = async mount => {
    if (mount?.fiber) await Promise.resolve().then(() => mount.fiber.dispose()).catch(() => {})
  }
  const mountOne = async (agent, bot, agentMounts, name) => {
    const sessionId = agent.session.id
    const item = own(library(), name)
    const drop = async () => {
      await disposeMount(agentMounts.get(name))
      agentMounts.delete(name)
    }
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'needs-approval' })
      return
    }
    let config
    try {
      config = configFor(item, bot.id)
    } catch (error) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
      return
    }
    const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
    if (agentMounts.get(name)?.key === key) return
    await drop()
    statusSet(bot.id, name, sessionId, { state: 'connecting' })
    try {
      const plugin = item.kind === 'skill'
        ? {
          name: `ds-bot-capability-skill-${name}`,
          inject: ['skills'],
          apply(c) {
            c.effect(() => c.skills.register({ name: config.name, description: config.description, source: 'runtime', provider: config.provider, content: config.content }))
          },
        }
        : await loadMcpPlugin()
      if (stopped) return
      const fiber = item.kind === 'skill' ? agent.ctx.plugin(plugin) : agent.ctx.plugin(plugin, config)
      agentMounts.set(name, { key, fiber })
      await fiber.await()
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      if (item.kind === 'skill') {
        // Instrumentation is not enough: DSH runtime registrations are
        // first-wins within one Agent layer. Verify the winner is this
        // capability, otherwise a same-name runtime skill is still callable.
        const winner = (await listProfileSkills({
          agent,
          cwd: skillCwd({ agent, botId: bot.id }),
          strict: true,
        })).find(skill => skill.name === name)
        if (winner?.provider !== config.provider) {
          throw new Error(`The DS-Bot skill ${name} did not become the visible catalog entry.`)
        }
      }
      statusSet(bot.id, name, sessionId, { state: 'ready' })
    } catch (error) {
      await drop()
      const message = rt.redactSecrets([error, error?.cause].filter(Boolean).map(part => String(part?.message ?? part)).join(': ') || 'Connection failed').slice(0, 300)
      statusSet(bot.id, name, sessionId, { state: 'error', error: message })
    }
  }
  const reconcileAgent = async (agent, bot) => {
    const sessionId = agent.session.id
    const shortlist = bot?.skillShortlist
    const chosen = Array.isArray(shortlist) ? new Set(shortlist.map(skill => skill.name)) : undefined
    const attached = new Set(bot ? expandCapabilityNames(bot.capabilities, library()) : [])
    // A shortlisted DS-Bot capability is an effective attachment without
    // rewriting the user's manual capability list.
    for (const skill of shortlist ?? []) {
      const item = own(library(), skill.name)
      if (item?.kind === 'skill') attached.add(item.name)
    }
    // MCPs and packs stay mounted. The shortlist only narrows skill items:
    // a manual skill attachment outside the shortlist is hidden, while a
    // shortlisted skill is effective. An empty shortlist must not unmount MCPs.
    const desired = new Set([...attached].filter(name => {
      const item = own(library(), name)
      return item?.kind !== 'skill' || chosen === undefined || chosen.has(name)
    }))
    const agentMounts = mounts.get(agent) ?? new Map()
    if (desired.size > 0) mounts.set(agent, agentMounts)
    if (bot) {
      for (const name of sessionStatuses.get(bot.id)?.keys() ?? []) {
        if (!desired.has(name)) clearStatus(bot.id, name, sessionId)
      }
    } else {
      clearSession(sessionId)
    }
    for (const [name, mount] of agentMounts) {
      if (desired.has(name)) continue
      await disposeMount(mount)
      agentMounts.delete(name)
    }
    await Promise.all([...desired].map(name => mountOne(agent, bot, agentMounts, name)))
    if (agentMounts.size === 0 && mounts.get(agent) === agentMounts) mounts.delete(agent)
    // Profile skills are hidden after capability mounts, so a DS-Bot skill of the
    // same name has already won the Agent layer and the mask cannot displace it.
    const mountedSkills = new Set(bot ? [...agentMounts.keys()].filter(name =>
      own(library(), name)?.kind === 'skill' && statusFor(bot.id, name)?.state === 'ready') : [])
    try {
      await applySkillMasks(agent, bot, mountedSkills)
      setSkillUnavailable(agent, false)
    } catch (error) {
      if (bot?.skillShortlist === undefined) throw error
      setSkillUnavailable(agent, true)
      rt.warn('ds-bot: skill mask for %s is unavailable; the skill loader is disabled: %s', sessionId, error)
    }
  }
  const botOfSession = sessionId => (rt.isBotSession(sessionId) ? rt.botOf(rt.selfOf(sessionId)) : undefined)
  // At most one run waits behind the running one; it reads the latest state when it starts.
  const reconcileOne = agent => {
    if (queued.has(agent)) return chains.get(agent)
    queued.add(agent)
    const run = (chains.get(agent) ?? Promise.resolve()).then(async () => {
      queued.delete(agent)
      const sessionId = agent.session.id
      if (stopped || agents.get(sessionId)?.deref() !== agent) return
      await reconcileAgent(agent, botOfSession(sessionId))
    }).catch(error => rt.warn('ds-bot: capability reconcile for %s failed: %s', agent.session?.id, error))
    chains.set(agent, run)
    return run
  }
  const loadInputs = async () => {
    await rt.load()
    loadingSecrets += 1
    try {
      await rt.loadSecrets()
    } finally {
      loadingSecrets -= 1
    }
  }
  async function reconcile() {
    if (stopped) return
    await loadInputs()
    const runs = []
    for (const [sessionId, reference] of agents) {
      const agent = reference.deref()
      if (agent) {
        runs.push(reconcileOne(agent))
        continue
      }
      agents.delete(sessionId)
      clearSession(sessionId)
    }
    await Promise.all(runs)
  }
  const scheduleReconcile = () => {
    if (!scheduled) {
      scheduled = new Promise(resolve => queueMicrotask(() => {
        scheduled = null
        resolve(reconcile().catch(error => rt.warn('ds-bot: capability reconcile failed: %s', error)))
      }))
    }
    return scheduled
  }
  // A profile skill installed, removed, or renamed changes both the picker and
  // the mask behind every live Agent. Refresh the picker before reconciling so
  // the next state answer carries the new catalog.
  function catalogChanged() {
    if (stopped) return
    if (masking > 0) {
      skillChangePending = true
      return
    }
    void refreshSkillCatalog()
    void scheduleReconcile()
  }
  // Run before the skill tool's own pre-step listener so a failed strict mask
  // rejects a direct `/name` invocation before its body can be injected.
  ctx.on?.('agent/pre-step', skillMaskPreStepGate(skillMaskUnavailable), { prepend: true })
  ctx.on?.('skills/change', catalogChanged)
  // A run that outlasts the limit goes on in the background, and later requests for the
  // same Agent do not wait for it again.
  const stalled = new WeakSet()
  const prepare = async (agent, sessionId) => {
    const run = loadInputs().then(() => reconcileOne(agent)).then(() => true, error => {
      rt.warn('ds-bot: capability mount for %s failed: %s', sessionId, error)
      return true
    })
    if (stalled.has(agent)) return
    const timeoutMs = rt.capabilityEnsureTimeoutMs ?? ENSURE_TIMEOUT_MS
    let timer
    const completed = await Promise.race([run, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, false) })])
    clearTimeout(timer)
    if (completed) return
    stalled.add(agent)
    void run.then(() => stalled.delete(agent))
    rt.warn('ds-bot: capability mount for %s did not finish within %dms; continuing', sessionId, timeoutMs)
  }
  async function ensureCapabilities(sessionId) {
    await rt.load()
    const bot = botOfSession(sessionId)
    if (!bot) return
    if ((bot.capabilities ?? []).length === 0 && bot.skillShortlist === undefined && !mounts.get(agents.get(sessionId)?.deref())?.size) return
    let agent
    try {
      agent = await rt.resolveAgent(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, rt.redactSecrets(String(error)))
      return
    }
    trackAgent(agent)
    await prepare(agent, sessionId)
  }
  const trackAgent = agent => {
    const sessionId = agent?.session?.id
    if (typeof sessionId !== 'string' || !agent.ctx) return
    if (agents.get(sessionId)?.deref() === agent) return
    agents.set(sessionId, new WeakRef(agent))
    agent.ctx.effect(() => () => {
      if (agents.get(sessionId)?.deref() === agent) agents.delete(sessionId)
      clearSession(sessionId)
      for (const mount of mounts.get(agent)?.values() ?? []) void disposeMount(mount)
      mounts.delete(agent)
      void skillMasks.get(agent)?.fiber?.dispose?.()
      skillMasks.delete(agent)
      setSkillUnavailable(agent, false)
    }, `ds-bot: capabilities ${sessionId}`)
    // Profile skill changes are observed by the root skills/change listener.
    // Keeping this listener off the Agent context avoids adding a scoped prompt
    // listener for every Bot Session.
  }
  const trackBotAgents = async bot => {
    const sessionIds = new Set()
    try {
      const sessionId = rt.chatOf(bot.id)
      if (typeof sessionId === 'string') sessionIds.add(sessionId)
    } catch (error) {
      rt.warn('ds-bot: capability chat session for %s could not be read: %s', bot.id, error)
    }
    try {
      for (const sessionId of rt.groupSessionsOf(bot.id) ?? []) {
        if (typeof sessionId === 'string') sessionIds.add(sessionId)
      }
    } catch (error) {
      rt.warn('ds-bot: capability group sessions for %s could not be read: %s', bot.id, error)
    }
    for (const sessionId of sessionIds) {
      try {
        trackAgent(await rt.resolveAgent(sessionId))
      } catch (error) {
        rt.warn('ds-bot: capability Agent for %s could not be resolved: %s', sessionId, error)
      }
    }
  }

  // A Bot may already have a live Agent that was not tracked at startup because it
  // had neither attachments nor a shortlist. Saving its first policy must find that
  // Agent before the next model step, not wait for a new Session.
  rt.capabilityChanged = async botId => {
    const bot = rt.botOf(botId)
    if (!bot) return
    await trackBotAgents(bot)
    await scheduleReconcile()
  }
  async function capabilityEndpoint(endpoint, body = {}) {

    if (endpoint === 'capability-save') return capabilitySave(body, { ui: true })
    if (endpoint === 'capability-delete') return capabilityDelete(body.name, { ui: true })
    if (endpoint === 'capability-approve') {
      await rt.load()
      writeCheck()
      const item = own(library(), String(body.name ?? ''))
      if (!item || item.kind !== 'mcp' || item.transport !== 'stdio') throw new Error(`No unapproved stdio MCP named ${body.name}.`)
      item.approved = true
      item.updatedAt = Date.now()
      await rt.save()
      return item
    }
    if (endpoint === 'bot-capability') {
      await rt.load()
      writeCheck()
      const bot = rt.botOf(String(body.botId ?? ''))
      if (!bot) throw new Error('Unknown Bot')
      const name = String(body.name ?? '')
      if (!own(library(), name)) throw new Error(`No capability named ${name}.`)
      return setAttached(bot, name, body.attached === true)
    }
    throw new Error('Unknown capability operation.')
  }
  const secretsChanged = rt.secretsChanged
  rt.secretsChanged = () => {
    secretsChanged?.()
    if (loadingSecrets === 0) void scheduleReconcile()
  }
  rt.capabilitiesStateSaved = () => { void refreshSkillCatalog(); void scheduleReconcile() }
  // Creation waits for these listeners, so a new Agent's first request already has its
  // tools and skill catalog. agent/pre-step is too late: a step assembles its tools first.
  ctx.on('agent/created', async function prepareCapabilities({ agent }) {
    trackAgent(agent)
    try {
      await rt.load()
      const bot = botOfSession(agent.session.id)
      if ((bot?.capabilities ?? []).length > 0 || bot?.skillShortlist !== undefined) await prepare(agent, agent.session.id)
    } catch (error) {
      rt.warn('ds-bot: capability load failed: %s', error)
    }
  })
  ctx.effect(() => {
    void rt.load().then(async () => {
      await refreshSkillCatalog({ publish: false })
      for (const bot of Object.values(state.bots)) {
        if ((bot.capabilities ?? []).length > 0 || bot.skillShortlist !== undefined) await trackBotAgents(bot)
      }
      await scheduleReconcile()
    }).catch(error => rt.warn('ds-bot: capability startup failed: %s', error))
    return async () => {
      stopped = true
      const live = [...mounts.values()]
      mounts.clear()
      agents.clear()
      sessionStatuses.clear()
      for (const record of skillMasks.values()) void record.fiber?.dispose?.()
      skillMasks.clear()
      for (const dispose of skillMaskUnavailable.values()) void dispose?.()
      skillMaskUnavailable.clear()
      await Promise.all(live.flatMap(agentMounts => [...agentMounts.values()].map(disposeMount)))
    }
  }, 'ds-bot: capabilities')
  Object.assign(rt, {
    capabilitySave,
    capabilityDelete,
    dropOrphanCapabilities,
    capabilityEndpoint,
    capabilityLibraryView: libraryView,
    capabilityStatusesView,
    reconcileCapabilities: reconcile,
    scheduleCapabilitiesReconcile: scheduleReconcile,
    ensureCapabilities,
    expandCapabilities: names => expandCapabilityNames(names, library()),
    changeCapabilityAttachment: changeAttachment,
  })
}
