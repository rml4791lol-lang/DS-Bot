// Tools that drive the user's ego lite through the ego-browser CLI. Every tool works
// inside one task space per Bot, and the space is created in the Bot's own ego profile
// so two Bots never share a login.
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { buildScript, runEgoScript } from './script.js'
import { appendAudit } from './audit.js'
import { EgoProfiles, profileForBot, requestedProfileName } from './profiles.js'
import { paymentError, paymentLike, parseWebUrl } from './policy.js'

export const systemPrompt = [
  'You browse through ego lite, the user\'s own Chromium. It keeps the logins the user already has, and every Bot works in its own profile and task space.',
  'ego_snapshot returns a semantic snapshot with numbered refs. Use a ref such as @12 or a CSS selector with ego_click, ego_type, and ego_press.',
  'Form submits and ego_run scripts need the user\'s approval. Payments are never done by you: call ego_handoff and stop.',
  'When a page needs a login, a payment, or a captcha, call ego_handoff with the reason and stop. Do not invent credentials. Call ego_resume only after the user says they are done.',
  'The user can take the page at any time in the ego panel; while they hold it, your tools will refuse to act. Wait for them to hand it back.',
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
    case 'handoff':
    case 'resume':
    case 'status':
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
      name: 'ego_status',
      description: 'Report whether ego lite is installed, which ego profile this Bot uses, and how to create it if it is missing.',
      parameters: {},
      action: 'status',
    },
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
      description: 'Fill a field in ego lite by snapshot ref or selector, optionally pressing Enter. Submitting needs approval.',
      parameters: {
        selector: selectorParam('Snapshot ref such as @12, or a CSS/text selector'),
        text: { type: 'string', required: true, description: 'Text to enter' },
        submit: { type: 'boolean', description: 'Press Enter after filling; this needs the user\'s approval' },
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
      description: 'Capture the ego lite page to a PNG file and return its absolute path. Older shots for this Bot are removed.',
      parameters: { fullPage: { type: 'boolean', description: 'Capture the full scrollable page' } },
      action: 'screenshot',
    },
    {
      name: 'ego_run',
      description: 'Run a JavaScript snippet inside this Bot\'s ego task space. `page` and `task` are available; every call needs the user\'s approval.',
      parameters: { script: { type: 'string', required: true, description: 'Async snippet body; use `return` to send a result' } },
      action: 'run',
    },
    {
      name: 'ego_handoff',
      description: 'Hand the ego page to the user for a login, captcha, payment, or confirmation, and stop until they hand it back.',
      parameters: {
        reason: { type: 'string', required: true, description: 'Why the user must take over: login, captcha, payment, confirmation, or other' },
        message: { type: 'string', description: 'What the user should do in the ego page' },
      },
      action: 'handoff',
    },
    {
      name: 'ego_resume',
      description: 'Take the ego page back after the user says they are done. Do not call this while the user is still working.',
      parameters: {},
      action: 'resume',
    },
  ]
}

/**
 * One Bot's profile name in ego. Profiles isolate cookies; task spaces do not.
 * @param {{ id?: string, name?: string, browserEgoProfile?: string }} bot
 */
export function egoProfileName(bot) {
  return requestedProfileName(bot)
}

export function egoSpaceName(bot) {
  return `Anbot · ${bot?.name ?? 'Bot'}`
}

export const SHOT_KEEP = 20

/** The screenshot tool is the only pixel that reaches disk; keep it bounded. */
export async function pruneShots(dir, keep = SHOT_KEEP) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return 0
    throw error
  }
  const shots = []
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue
    const path = join(dir, entry.name)
    try {
      const info = await stat(path)
      shots.push({ path, time: info.mtimeMs })
    } catch { /* a file that vanished is already gone */ }
  }
  shots.sort((a, b) => b.time - a.time)
  const stale = shots.slice(Math.max(0, keep))
  await Promise.all(stale.map(item => unlink(item.path).catch(() => {})))
  return stale.length
}

function resultText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  return JSON.stringify(value, null, 2)
}

export function createRunner({ rt, cli, host, authorize, lease, onProfile }) {
  const profiles = new EgoProfiles({ home: rt.home })

  async function remember(botId, used) {
    if (used.profileId === undefined || used.profileId === null) return
    await profiles.remember(botId, used)
    onProfile?.(botId, used)
  }

  async function currentUrl(bot, profileId, profileName) {
    const result = await runEgoScript(cli, buildScript({
      space: egoSpaceName(bot),
      profileId,
      profileName,
      body: 'return await page.url()',
    }), { timeoutMs: 30_000 })
    if (!result.ok) throw new Error(`ego lite: ${result.error}`)
    if (result.result?.profileId !== undefined) {
      await remember(bot.id, { profileId: result.result.profileId, profileName: result.result.profileName ?? profileName })
    }
    return { url: String(result.result?.value ?? ''), profileId: result.result?.profileId ?? profileId, profileName: result.result?.profileName ?? profileName }
  }

  async function approve(exec, botId, action, bot, profileId, profileName) {
    const page = await currentUrl(bot, profileId, profileName)
    let parsed
    try { parsed = new URL(page.url) } catch { parsed = null }
    const host = parsed?.hostname || 'the current page'
    const origin = parsed?.origin || ''
    if (authorize === undefined) {
      throw new Error('This action needs the user\'s approval, and there is no approval service here. Nothing was done.')
    }
    await authorize(exec, botId, {
      kind: action,
      label: action === 'script' ? 'Run a page script' : 'Submit a form',
      host,
      origin,
    })
    return page
  }

  return async function perform(action, args, exec) {
    const botId = await host.resolveBotId(exec)
    const bot = botId === undefined ? undefined : rt.botOf(botId)
    if (bot === undefined) throw new Error('This session is not a Bot, so it has no ego browser.')
    const stored = await profiles.get(botId)
    const profile = profileForBot(bot, stored)
    const profileName = profile.profileName
    const profileId = profile.profileId
    const target = action === 'click' || action === 'type' || action === 'press'
      ? String(args.selector ?? '').slice(0, 80)
      : null
    const started = Date.now()
    let auditProfile = { profileId, profileName }

    if (action === 'status') {
      return [
        `ego-browser: ${cli}`,
        `ego lite: ${rt.egoBrowser?.app ?? 'not found in /Applications'}`,
        `profile for ${bot.name}: ${profileName}${profileId ? ` (id ${profileId})` : ' (not linked yet; create it in ego lite)'}`,
        `space: ${egoSpaceName(bot)}`,
      ].join('\n')
    }

    if (action === 'handoff') {
      const reason = String(args.reason ?? 'other').slice(0, 80)
      lease.takeUser(botId, { reason, indefinite: true })
      await appendAudit(rt.home, botId, { tool: 'ego_handoff', action, outcome: 'handoff', reason, profileId, profileName, durationMs: Date.now() - started })
      const detail = typeof args.message === 'string' && args.message.trim() ? `\n${args.message.trim().slice(0, 500)}` : ''
      return `The user now has control of the ego page (${reason}). Stop here and wait. Call ego_resume only after the user says they are done.${detail}`
    }

    if (action === 'resume') {
      lease.resume(botId)
      await appendAudit(rt.home, botId, { tool: 'ego_resume', action, outcome: 'resume', profileId, profileName, durationMs: Date.now() - started })
      return 'Control is back with you. Continue, and take a fresh snapshot before the next click.'
    }

    const claim = lease.beginBot(botId, exec.callId ?? exec.id)
    if (!claim.ok) {
      throw new Error(claim.owner === 'user'
        ? 'The user is controlling this ego page right now. Wait for them to hand it back, or call ego_resume only after they say they are done. Nothing was done.'
        : 'Another ego action is still running for this Bot. Wait for it to finish. Nothing was done.')
    }

    const audit = (outcome, extra = {}) => appendAudit(rt.home, botId, {
      tool: `ego_${action}`,
      action,
      outcome,
      url: extra.url ?? '',
      profileId: extra.profileId ?? auditProfile.profileId,
      profileName: extra.profileName ?? auditProfile.profileName,
      target,
      reason: extra.reason,
      durationMs: Date.now() - started,
    })

    try {
      if (action === 'open') args = { ...args, url: parseWebUrl(args.url).href }
      if (action === 'click' && paymentLike(args.label)) throw paymentError('')

      if (action === 'type' && args.submit === true) {
        const page = await approve(exec, botId, 'submit', bot, profileId, profileName)
        auditProfile = { profileId: page.profileId, profileName: page.profileName }
      }
      if (action === 'run') {
        if (typeof args.script !== 'string' || args.script.trim() === '') throw new Error('ego_run needs a script.')
        const page = await approve(exec, botId, 'script', bot, profileId, profileName)
        auditProfile = { profileId: page.profileId, profileName: page.profileName }
      }

      let body = actionBody(action, args)
      let path
      if (action === 'screenshot') {
        const dir = join(rt.home, 'browser-shots', String(botId))
        await mkdir(dir, { recursive: true })
        path = join(dir, `${Date.now()}.png`)
        body = `await page.screenshot({ path: ${JSON.stringify(path)}, fullPage: ${args.fullPage === true} }); return { path: ${JSON.stringify(path)} }`
      }

      const result = await runEgoScript(cli, buildScript({
        space: egoSpaceName(bot),
        profileId: auditProfile.profileId,
        profileName: auditProfile.profileName,
        body,
      }), { timeoutMs: action === 'run' ? 120_000 : 60_000 })

      if (!result.ok) {
        const error = new Error(`ego lite: ${result.error}`)
        error.code = result.code
        if (result.code === 'EGO_PROFILE_MISSING') {
          const missing = new Error(`${result.error}\n\nOpen ego lite, create that profile, and retry. This Bot did not use the user's default profile.`)
          missing.code = 'EGO_PROFILE_MISSING'
          throw missing
        }
        throw error
      }

      const used = { profileId: result.result?.profileId ?? auditProfile.profileId, profileName: result.result?.profileName ?? auditProfile.profileName }
      if (used.profileId !== undefined) await remember(botId, used)
      auditProfile = used
      if (action === 'screenshot' && path) await pruneShots(join(rt.home, 'browser-shots', String(botId))).catch(() => {})
      await audit('ok', { url: result.result?.url ?? '', ...used })

      return resultText(result.result?.value)
    } catch (error) {
      await audit(error?.code === 'EGO_PROFILE_MISSING' ? 'profile-missing' : 'error', { reason: error?.message })
      throw error
    } finally {
      lease.endBot(botId, exec.callId ?? exec.id)
    }
  }
}
