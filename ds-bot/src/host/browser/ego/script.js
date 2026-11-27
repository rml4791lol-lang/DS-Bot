// Build and run ego-browser scripts. The CLI starts a Node process per call and keeps
// task spaces on the ego side; every call therefore carries the space name and the
// profile it must belong to, and returns one JSON line the host can parse.
import { execFile } from 'node:child_process'

export const RESULT_SENTINEL = '@@ANBOT_EGO@@'
export const ERROR_SENTINEL = '@@ANBOT_EGO_ERROR@@'

/**
 * @param {{ space: string, profileId?: string, profileName?: string, body: string }} input
 */
export function buildScript({ space, profileId, profileName, body }) {
  return `(async () => {
  const spaceName = ${JSON.stringify(space)};
  const wantedId = ${JSON.stringify(profileId ?? '')};
  const wantedName = ${JSON.stringify(profileName ?? '')};
  const list = await profiles();
  let profile;
  if (wantedId) profile = list.find(item => String(item.id) === String(wantedId));
  if (!profile && wantedName) profile = list.find(item => item.name === wantedName);
  if (!profile) {
    const label = wantedName || String(wantedId);
    console.log(${JSON.stringify(ERROR_SENTINEL)} + JSON.stringify({
      code: 'EGO_PROFILE_MISSING',
      message: 'No ego profile named "' + label + '". Create that profile in ego lite (Profiles), then retry. Nothing was opened.',
    }));
    process.exitCode = 1;
    return;
  }
  const task = await taskSpace(spaceName, { profileId: profile.id });
  const pages = await task.pages();
  const page = pages[0] ?? await task.newPage();
  const out = await (async () => { ${body} })();
  console.log(${JSON.stringify(RESULT_SENTINEL)} + JSON.stringify({
    spaceId: task.spaceId,
    profileId: profile.id,
    profileName: profile.name ?? wantedName,
    url: await page.url(),
    value: out ?? null,
  }));
})().catch((error) => {
  console.log(${JSON.stringify(ERROR_SENTINEL)} + JSON.stringify({ message: String(error && error.message || error) }));
  process.exitCode = 1;
});
`
}

function scan(text) {
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith(RESULT_SENTINEL)) {
      try {
        return { ok: true, result: JSON.parse(line.slice(RESULT_SENTINEL.length)) }
      } catch (error) {
        return { ok: false, error: `ego result was not JSON: ${error?.message ?? error}` }
      }
    }
    if (line.startsWith(ERROR_SENTINEL)) {
      try {
        const payload = JSON.parse(line.slice(ERROR_SENTINEL.length))
        return { ok: false, error: payload?.message ?? 'ego script failed.', ...(payload?.code ? { code: payload.code } : {}) }
      } catch {
        return { ok: false, error: line.slice(ERROR_SENTINEL.length) || 'ego script failed.' }
      }
    }
  }
  return null
}

// ego-browser writes the script output to stderr, keeping stdout for its own framing.
function parse(...texts) {
  for (const text of texts) {
    const found = scan(text)
    if (found !== null) return found
  }
  return { ok: false, error: (String(texts.find(Boolean) ?? '').trim() || 'ego-browser produced no result.').slice(0, 4000) }
}

/**
 * @param {string} cliPath
 * @param {string} script
 * @param {{ timeoutMs?: number, run?: (file: string, args: string[], options: object) => Promise<{ stdout: string, stderr: string }> }} [options]
 */
export async function runEgoScript(cliPath, script, { timeoutMs = 60_000, run } = {}) {
  const exec = run ?? ((file, args, options) => new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  }))
  let output
  try {
    output = await exec(cliPath, ['nodejs', '-e', script], { timeout: timeoutMs, env: process.env })
  } catch (error) {
    const stdout = String(error?.stdout ?? '')
    // A structured error the script printed is more useful than a spawn message.
    const stderrText = String(error?.stderr ?? '')
    if (stdout.includes(ERROR_SENTINEL) || stderrText.includes(ERROR_SENTINEL)) return parse(stdout, stderrText)
    const detail = String(stderrText || error?.message || error).trim()
    return { ok: false, error: (detail || parse(stdout, stderrText).error).slice(0, 4000) }
  }
  return parse(output?.stdout, output?.stderr)
}
