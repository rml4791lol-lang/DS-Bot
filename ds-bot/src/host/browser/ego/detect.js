// Locate the ego-browser CLI that drives ego lite. Detection is synchronous so the
// browser slot can default to ego at startup without waiting on a probe.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const NAMES = ['ego-browser', 'ego-browser.exe', 'ego-browser.cmd']

function usable(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * @param {{ env?: Record<string, string | undefined>, home?: string, platform?: NodeJS.Platform }} [options]
 * @returns {string | undefined} absolute path of the ego-browser executable
 */
export function findEgoCli({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  for (const key of ['ANBOT_EGO_CLI', 'EGO_BROWSER_BIN']) {
    const value = env[key]
    if (value && isAbsolute(value) && usable(value)) return value
  }
  const dirs = []
  const path = env.PATH ?? env.Path ?? ''
  for (const dir of path.split(delimiter)) if (dir) dirs.push(dir)
  dirs.push(
    join(home, '.local', 'bin'),
    join(home, '.local', 'bin', platform === 'win32' ? 'ego-browser.exe' : ''),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    platform === 'win32' ? join(home, 'AppData', 'Local', 'ego-browser') : '/usr/bin',
  )
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of NAMES) {
      const candidate = join(dir, name)
      if (usable(candidate)) return candidate
    }
  }
  return undefined
}

/** The official app bundle, used only to point the user at an install or launch. */
export function findEgoApp({ platform = process.platform } = {}) {
  if (platform !== 'darwin') return undefined
  for (const root of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of ['ego lite.app', 'ego(lite).app', 'Ego Lite.app']) {
      const candidate = join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}
