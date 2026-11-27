// Registers ego lite as a built-in browser provider in the `browser` slot. The
// provider is visible even when ego is not installed, so a Bot can tell the user how
// to install it; only an installed CLI is allowed to become the default browser.
import * as detect from './detect.js'
import { EgoBridge } from './bridge.js'
import { EgoLease } from './lease.js'
import { readProfileMapSync, profileForBot } from './profiles.js'
import { createRunner, egoSpaceName, systemPrompt, toolDefs } from './tools.js'
import { output } from '../../tools.js'

export const EGO_PROVIDER_ID = 'builtin:ego'

const NOT_INSTALLED = 'ego lite is not installed. Install ego lite, then make sure ego-browser is on PATH or set ANBOT_EGO_CLI. This Bot cannot open a browser until then.'

export function installEgo(rt, { findEgoCli = detect.findEgoCli, findEgoApp = detect.findEgoApp, authorize } = {}) {
  const cli = findEgoCli()
  const app = findEgoApp()
  rt.egoBrowser = { cli, app, available: Boolean(cli) }
  const defs = toolDefs()
  const toolPrefixes = cli ? defs.map(tool => tool.name) : ['ego_status']

  rt.plugins?.registerBuiltin?.({
    id: EGO_PROVIDER_ID,
    name: 'Ego Lite Browser',
    description: cli
      ? 'Drive the user\'s own ego lite Chromium through ego-browser, one isolated profile and task space per Bot.'
      : 'ego lite is not installed. Install it to give Bots the user\'s real logins, with one isolated profile per Bot.',
    category: 'browser',
    slot: 'browser',
    supportsGrants: Boolean(cli),
    toolPrefixes,
    locales: {
      zh: {
        name: 'Ego Lite 浏览器',
        description: cli
          ? '通过 ego-browser 驱动你自己的 ego lite，每个 Bot 一个独立 profile 与任务空间。'
          : '尚未安装 ego lite。安装后每个 Bot 可使用你的真实登录态，并各自拥有独立 profile。',
      },
    },
    mount(host) {
      const lease = new EgoLease()

      if (!cli) {
        const entry = host.registerTool(host.defineTool({
          name: 'ego_status',
          description: 'Report whether ego lite is installed and how to install it.',
          parameters: {},
          output,
          async execute() {
            return `${NOT_INSTALLED}\n\nAsk the user to install ego lite; an agent may help run the installer. Then retry ego_status.`
          },
        }))
        const frame = async () => ({ error: NOT_INSTALLED, code: 'EGO_NOT_INSTALLED' })
        const input = () => false
        rt.browserFrame = frame
        rt.egoInput = input
        return {
          frame,
          input,
          drop: () => {},
          dispose: () => {
            entry?.dispose?.()
            if (rt.browserFrame === frame) rt.browserFrame = undefined
            if (rt.egoInput === input) rt.egoInput = undefined
          },
        }
      }

      const profiles = readProfileMapSync(rt.home)
      const perform = createRunner({
        rt,
        cli,
        host,
        authorize,
        lease,
        onProfile: (botId, used) => { profiles[String(botId)] = { ...used, updatedAt: Date.now() } },
      })
      const bridges = new Map()
      const touched = new Map()
      const profileOf = bot => profileForBot(bot, profiles[String(bot.id)])

      const bridgeOf = botId => {
        const bot = rt.botOf(botId)
        if (bot === undefined) return undefined
        let bridge = bridges.get(botId)
        if (bridge === undefined) {
          const profile = profileOf(bot)
          bridge = new EgoBridge({
            cli,
            space: egoSpaceName(bot),
            profileId: profile.profileId,
            profileName: profile.profileName,
          })
          bridges.set(botId, bridge)
          bridge.start()
        }
        return bridge
      }

      const frame = async (botId, since) => {
        const id = String(botId ?? '')
        const bridge = bridgeOf(id)
        if (bridge === undefined) return undefined
        touched.set(id, Date.now())
        const latest = await bridge.waitForFrame(typeof since === 'number' ? since : undefined)
        if (lease.owner(id) === 'user') lease.touchUser(id)
        if (latest !== undefined) {
          return {
            mime: latest.mime,
            data: latest.data,
            url: latest.url,
            title: latest.title,
            seq: latest.seq,
            width: latest.width,
            height: latest.height,
            owner: lease.owner(id),
          }
        }
        if (bridge.error) return { error: bridge.error, code: bridge.errorCode, owner: lease.owner(id) }
        return { starting: true, owner: lease.owner(id) }
      }

      const input = (botId, event) => {
        if (event === null || typeof event !== 'object') return false
        const id = String(botId ?? '')
        const allowed = new Set(['click', 'wheel', 'insert', 'key', 'navigate', 'stop', 'resume'])
        if (!allowed.has(event.type)) return false
        const bridge = bridgeOf(id)
        if (bridge === undefined) return false
        if (event.type === 'resume') {
          lease.resume(id)
          touched.set(id, Date.now())
          return true
        }
        if (event.type === 'navigate') {
          let url
          try { url = new URL(String(event.url ?? '')) } catch { return false }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
        }
        lease.takeUser(id)
        touched.set(id, Date.now())
        return bridge.input(event)
      }

      const registered = []
      for (const def of defs) {
        registered.push(host.registerTool(host.defineTool({
          name: def.name,
          description: def.description,
          parameters: def.parameters,
          output,
          async execute(args, exec) {
            return perform(def.action, args, exec)
          },
        })))
      }
      rt.browserFrame = frame
      rt.egoInput = input
      // A panel that closed leaves the bridge streaming: stop one after five quiet minutes.
      const sweeper = setInterval(() => {
        const now = Date.now()
        for (const [botId, bridge] of bridges) {
          if (now - (touched.get(botId) ?? 0) > 5 * 60_000) {
            bridge.stop()
            bridges.delete(botId)
            touched.delete(botId)
            lease.resume(botId)
          }
        }
      }, 60_000)
      sweeper.unref?.()
      return {
        frame,
        input,
        drop: botId => {
          bridges.get(String(botId))?.stop()
          bridges.delete(String(botId))
          lease.resume(String(botId))
        },
        dispose: () => {
          clearInterval(sweeper)
          for (const bridge of bridges.values()) bridge.stop()
          bridges.clear()
          if (rt.browserFrame === frame) rt.browserFrame = undefined
          if (rt.egoInput === input) rt.egoInput = undefined
          registered.forEach(entry => entry?.dispose?.())
        },
      }
    },
  })

  // Consulted only when no slot choice is saved; an explicit choice always wins.
  // The desktop app defaults to ego; a plain DSH/test runtime keeps the read-only
  // fallback unless it opts in, so unit tests never depend on what is installed.
  const defaultOn = () => Boolean(cli) && (process.env.DS_BOT_APP === '1' || rt.config?.browserEgoDefault === true)
  rt.defaultBrowserTarget = () => (defaultOn() ? EGO_PROVIDER_ID : null)
  return Boolean(cli)
}

export { systemPrompt, toolDefs }
