// Registers ego lite as a built-in browser provider in the `browser` slot, and makes it
// the default browser when the CLI is installed and the user has not chosen another.
import * as detect from './detect.js'
import { createRunner, systemPrompt, toolDefs } from './tools.js'
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
      return { dispose: () => registered.forEach(entry => entry?.dispose?.()) }
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
