import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/gate.test.sh', import.meta.url))

// The gate is a shell script and these tests drive it as one, against scratch repositories; this
// runs them under `npm test` and shows their output when one fails. Git Bash on Windows exposes
// POSIX-looking paths but cannot create the dangling symlinks and `/c/...` fixtures used below.
const skip = process.platform === 'win32'
  ? 'gate.test.sh is covered on Linux and macOS; its POSIX paths and symlink fixtures are not portable to Windows'
  : false
test('the gate, its hooks and install-hooks.sh behave', { skip }, () => {
  const run = spawnSync('sh', [script], { encoding: 'utf8', timeout: 110000 })
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
})
