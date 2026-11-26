// Tools that drive the user's ego lite through the ego-browser CLI. Every tool works
// inside one task space per Bot, and the space is created in the Bot's own ego profile
// so two Bots never share a login.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { buildScript, runEgoScript } from './script.js'

export const systemPrompt = [
  'You browse through ego lite, the user\'s own Chromium. It keeps the logins the user already has, and every Bot works in its own profile and task space.',
  'ego_snapshot returns a semantic snapshot with numbered refs. Use a ref such as @12 or a CSS selector with ego_click, ego_type, and ego_press.',
  'When a page needs a login, a payment, or a captcha, stop and ask the user to take over in the ego window. Do not invent credentials.',
  'Prefer ego_run only when the structured tools do not cover the job: inside it, `page` and `task` are the ego Page and TaskSpace handles.',
].join('\n')

const selectorParam = description => ({ type: 'string', required: true, description })

export function actionBody(action, args) {
  switch (action) {
    case 'open':
      return `await page.goto(${JSON.stringify(args.url)}, { waitUntil: 'domcontentloaded' }); return await page.snapshot()`
    case 'snapshot':
      return args.scope
        ? `return await page.snapshot({ scope: ${JSON.stringify(args.scope)} })`
        : 'return await page.snapshot()'
    case 'click':
      return `await page.click(${JSON.stringify(args.selector)}, ${JSON.stringify({ label: args.label, timeout: args.timeout }) }); return await page.snapshot()`
    case 'type':
      return `await page.fill(${JSON.stringify(args.selector)}, ${JSON.stringify(args.text)}, { clearFirst: true });`
        + (args.submit ? ` await page.press(${JSON.stringify(args.selector)}, 'Enter');` : '')
        + ' return await page.snapshot()'
    case 'press':
      return `await page.press(${JSON.stringify(args.selector)}, ${JSON.stringify(args.key)}); return await page.snapshot()`
    case 'screenshot':
      return null
    case 'run':
      return args.script
    default:
      throw new Error(`Unknown ego action "${action}".`)
  }
}

export function toolDefs() {
  return [
    {
      name: 'ego_open',
      description: 'Open a URL in this Bot\'s ego lite page and return the page snapshot.',
      parameters: { url: { type: 'string', required: true, description: 'URL to open' } },
      action: 'open',
    },
    {
      name: 'ego_snapshot',
      description: 'Return the semantic snapshot of the current ego lite page.',
      parameters: { scope: { type: 'string', description: 'full_page or only_within_viewport (default)' } },
      action: 'snapshot',
    },
    {
      name: 'ego_click',
      description: 'Click an element in ego lite by snapshot ref or selector, then return a fresh snapshot.',
      parameters: {
        selector: selectorParam('Snapshot ref such as @12, or a CSS/text selector'),
        label: { type: 'string', description: 'Short description of the action, shown next to the cursor' },
        timeout: { type: 'number', description: 'Milliseconds to wait for the element' },
      },
      action: 'click',
    },
    {
      name: 'ego_type',
      description: 'Fill a field in ego lite by snapshot ref or selector, optionally pressing Enter.',
      parameters: {
        selector: selectorParam('Snapshot ref such as @12, or a CSS/text selector'),
        text: { type: 'string', required: true, description: 'Text to enter' },
        submit: { type: 'boolean', description: 'Press Enter after filling' },
      },
      action: 'type',
    },
    {
      name: 'ego_press',
      description: 'Press a key in ego lite, optionally on a focused element.',
      parameters: {
        selector: { type: 'string', description: 'Snapshot ref or selector; omit to press on the focused element' },
        key: { type: 'string', required: true, description: 'Key name such as Enter, Escape, ArrowDown, or a single character' },
      },
      action: 'press',
    },
    {
      name: 'ego_screenshot',
      description: 'Capture the ego lite page to a PNG file and return its absolute path.',
      parameters: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page' } },
      action: 'screenshot',
    },
    {
      name: 'ego_run',
      description: 'Run a JavaScript snippet inside this Bot\'s ego task space. `page` and `task` are available; return a JSON-serializable value.',
      parameters: { script: { type: 'string', required: true, description: 'Async snippet body; use `return` to send a result' } },
      action: 'run',
    },
  ]
}

/**
 * One Bot's profile name in ego. Profiles isolate cookies; task spaces do not.
 * @param {{ id?: string, name?: string, browserEgoProfile?: string }} bot
 */
export function egoProfileName(bot) {
  const explicit = typeof bot?.browserEgoProfile === 'string' ? bot.browserEgoProfile.trim() : ''
  if (explicit) return explicit
  return `Anbot · ${bot?.name ?? 'Bot'}`
}

export function egoSpaceName(bot) {
  return `Anbot · ${bot?.name ?? 'Bot'}`
}

export function createRunner({ rt, cli, host }) {
  return async function perform(action, args, exec) {
    const botId = await host.resolveBotId(exec)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (bot === undefined) throw new Error('This session is not a Bot, so it has no ego browser.')
    const profileName = egoProfileName(bot)
    let body = actionBody(action, args)
    if (action === 'screenshot') {
      const dir = join(rt.home, 'browser-shots', String(botId))
      await mkdir(dir, { recursive: true })
      const path = join(dir, `${Date.now()}.png`)
      body = `await page.screenshot({ path: ${JSON.stringify(path)}, fullPage: ${args.fullPage === true} }); return { path: ${JSON.stringify(path)} }`
    }
    const result = await runEgoScript(cli, buildScript({ space: egoSpaceName(bot), profileName, body }), { timeoutMs: action === 'run' ? 120_000 : 60_000 })
    if (!result.ok) throw new Error(`ego lite: ${result.error}`)
    const value = result.result?.value
    const note = result.result?.profileId === null ? `\n\n（ego 里没有名为 “${profileName}” 的 profile，本次使用了默认 profile；请在 ego 里为 ${bot.name} 建一个同名 profile。）` : ''
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
    return `${text ?? ''}${note}`
  }
}
