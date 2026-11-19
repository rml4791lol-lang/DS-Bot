import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

function filesUnder(root) {
  const files = []
  const walk = (path, prefix = '') => {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const stat = lstatSync(absolute)
      if (stat.isDirectory()) walk(absolute, relative)
      else files.push({ absolute, relative, stat })
    }
  }
  walk(root)
  return files
}

async function installedState(root) {
  const files = filesUnder(root)
  const hashes = Array.from({ length: files.length })
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const index = next++
      const file = files[index]
      hashes[index] = createHash('sha256').update(await readFile(file.absolute)).digest('hex')
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker))
  const tree = createHash('sha256')
  for (const [index, file] of files.entries()) {
    tree.update(`${file.relative}\0${file.stat.size}\0${hashes[index]}\0`)
  }
  return { files: files.length, tree: `sha256:${tree.digest('hex')}` }
}

function checkoutState(root) {
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
  const statusLines = status.split('\n').filter(Boolean)
  const tracked = digest(git(root, ['diff', '--binary', '--no-ext-diff', 'HEAD']))
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)
    .sort()
    .map(path => ({ path, digest: digest(readFileSync(join(root, path))) }))
  return {
    head,
    statusDigest: digest(status),
    statusLines,
    trackedDiffDigest: tracked,
    untracked,
  }
}

export async function targetSnapshot(target) {
  if (target.kind === 'git-checkout') return checkoutState(target.path)
  if (target.kind === 'installed-packages') return installedState(target.path)
  throw new Error(`unknown DSH target kind ${target.kind}`)
}

export async function snapshotTargets(targets) {
  return await Promise.all(targets.map(async target => ({
    label: target.label,
    kind: target.kind,
    state: await targetSnapshot(target),
  })))
}
