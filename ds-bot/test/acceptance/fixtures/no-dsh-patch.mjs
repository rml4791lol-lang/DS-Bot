import { readFileSync } from 'node:fs'
import { snapshotTargets } from './dsh-invariant.mjs'

const baselinePath = process.env.DSH_PATCH_BASELINE
const targetsText = process.env.DSH_PATCH_TARGETS
if (!baselinePath || !targetsText) throw new Error('DSH patch baseline and targets are required')

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const targets = JSON.parse(targetsText)
const current = await snapshotTargets(targets)
const changed = current.filter((target, index) => JSON.stringify(target.state) !== JSON.stringify(baseline[index].state))
if (changed.length > 0) throw new Error(`DSH changed during the run: ${JSON.stringify(changed)}`)

console.log(JSON.stringify({
  changedPaths: [],
  dshPatched: false,
  targets: current.map(target => ({
    label: target.label,
    kind: target.kind,
    unchanged: true,
    preexistingChanges: target.kind === 'git-checkout' ? target.state.statusLines.length : 0,
    preexistingPaths: target.kind === 'git-checkout' ? target.state.statusLines.map(line => line.slice(3)) : [],
    untrackedFiles: target.kind === 'git-checkout' ? target.state.untracked.map(file => file.path) : [],
    files: target.state.files,
    tree: target.state.tree,
    head: target.state.head,
    statusDigest: target.state.statusDigest,
    trackedDiffDigest: target.state.trackedDiffDigest,
  })),
}))
