// Registers ego lite as a built-in browser provider in the `browser` slot, and makes it
// the default browser when the CLI is installed and the user has not chosen another.
import * as detect from './detect.js'
import { EgoBridge } from './bridge.js'
import { createRunner, egoProfileName, egoSpaceName, systemPrompt, toolDefs } from './tools.js'
import { output } from '../../tools.js'

export const EGO_PROVIDER_ID = 'builtin:ego'

export function installEgo(rt, { findEgoCli = detect.findEgoCli, findEgoApp = detect.findEgoApp } = {}) {
  const cli = findEgoCli()
  const app = findEgoApp()
  rt.egoBrowser = { cli, app, available: Boolean(cli) }
  if (!cli) return false

  rt.plugins?.registerBuiltin?.({
    id: EGO_PROVIDER_ID,
    name: 'Ego Lite Browser',
    description: 'Drive the user\'s own ego lite Chromium through ego-browser, one isolated profile and task space per Bot.',
    category: 'browser',
    slot: 'browser',
    supportsGrants: false,
    toolPrefixes: toolDefs().map(tool => tool.name),
    locales: {
      zh: {
        name: 'Ego Lite 浏览器',
        description: '通过 ego-browser 驱动你自己的 ego lite，每个 Bot 一个独立 profile 与任务空间。',
      },
    },
    mount(host) {
      const perform = createRunner({ rt, cli, host })
      const bridges = new Map()
      const bridgeOf = botId => {
        const bot = rt.botOf(botId)
        if (bot === undefined) return undefined
        let bridge = bridges.get(botId)
        if (bridge === undefined) {
          bridge = new EgoBridge({ cli, space: egoSpaceName(bot), profileName: egoProfileName(bot) })
          bridges.set(botId, bridge)
          bridge.start()
        }
        return bridge
      }
      const touched = new Map()
      const frame = async (botId, since) => {
        const bridge = bridgeOf(String(botId ?? ''))
        if (bridge === undefined) return undefined
        touched.set(String(botId), Date.now())
        const latest = await bridge.waitForFrame(typeof since === 'number' ? since : undefined)
        if (latest === undefined) return undefined
        return { mime: latest.mime, data: latest.data, url: latest.url, title: latest.title, seq: latest.seq, width: latest.width, height: latest.height }
      }
      const input = (botId, event) => {
        if (event === null || typeof event !== 'object') return false
        touched.set(String(botId), Date.now())
        const allowed = new Set(['click', 'wheel', 'insert', 'key', 'navigate', 'stop'])
        if (!allowed.has(event.type)) return false
        const bridge = bridgeOf(String(botId ?? ''))
        if (bridge === undefined) return false
        if (event.type === 'navigate') {
          let url
          try { url = new URL(String(event.url ?? '')) } catch { return false }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
        }
        return bridge.input(event)
      }
      const registered = []
      for (const def of toolDefs()) {
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
          }
        }
      }, 60_000)
      sweeper.unref?.()
      return {
        frame,
        input,
        drop: botId => { bridges.get(botId)?.stop(); bridges.delete(botId) },
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
  // The desktop app defaults to ego; a plain DSH/test runtime keeps the read-only fallback
  // unless it opts in, so unit tests never depend on what is installed on the machine.
  const defaultOn = () => process.env.DS_BOT_APP === '1' || rt.config?.browserEgoDefault === true
  rt.defaultBrowserTarget = () => (defaultOn() ? EGO_PROVIDER_ID : null)
  return true
}

export { systemPrompt, toolDefs }
