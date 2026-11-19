// Verify every Bot's shortlist names against the REAL DSH profile catalog.
//
// Mounts the official skill registry and filesystem provider with the default
// roots (the same `ds-bot-profile` provider cordis.patch.yml mounts), then runs
// the host's own validateShortlistAgainstCatalog over each Bot's names.
//
// Usage, from ds-bot/:
//   node --import ./test/harness-resolve.mjs test/probe-shortlists.mjs <shortlist.json> [purposes.json] [cwd]
//
// shortlist.json is `{ "cases": { "<Bot>": ["<skill>", ...] } }` or a plain
// `{ "<Bot>": [...] }` map. purposes.json is `{ "<skill>": "<one line>" }`; a
// missing purpose falls back to a generic line so the shape check still runs.
// Exits 1 when any Bot's list names a skill the catalog does not have.
//
// This probes the HOST layer only. DS-Bot capability skills (for example
// bot-dispatch-and-reporting) and skills a plugin registers in the Agent scope
// (ppt-studio, graphlint, opendesign, office-docx, goal-grill) are merged at
// runtime; a FAIL naming one of those is the agent/capability layer, not a
// missing host entry. The host accepts them through the live-Agent union — see
// the regression test in test/roster.test.js.
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as FsSkill from '@deepseek-ai/dsh-skill-filesystem'
import { catalogEntries, validateShortlistAgainstCatalog } from '../src/host/skill-catalog.js'

const [shortlistPath, purposesPath, cwd = process.cwd()] = process.argv.slice(2)
if (shortlistPath === undefined) {
  console.error('usage: node --import ./test/harness-resolve.mjs test/probe-shortlists.mjs <shortlist.json> [purposes.json] [cwd]')
  process.exit(2)
}
const purposes = purposesPath === undefined
  ? {}
  : JSON.parse(readFileSync(purposesPath, 'utf8'))
const parsed = JSON.parse(readFileSync(shortlistPath, 'utf8'))
const botLists = parsed.cases ?? parsed

const ctx = new Context()
await ctx.plugin(SkillRegistry)
await ctx.plugin(FsSkill, { providerName: 'ds-bot-profile' })

const profile = await ctx.skills.list({ cwd })
const catalog = catalogEntries(profile)
console.log(`profileEntries ${profile.length} catalogEntries ${catalog.length}`)
const names = new Set(catalog.map(skill => skill.name))
for (const probe of ['test-driven-development', 'systematic-debugging', 'code-review-and-quality', 'ppt-studio', 'graphlint', 'orchestration']) {
  console.log(`name ${probe} present=${names.has(probe)}`)
}

let failures = 0
const applied = {}
for (const [bot, list] of Object.entries(botLists)) {
  const shaped = list.map(name => ({ name, purpose: purposes[name] ?? `Use ${name} when the task calls for it.` }))
  try {
    const checked = validateShortlistAgainstCatalog(shaped, catalog)
    applied[bot] = checked
    console.log(`OK ${bot} n=${checked.length} ${checked.map(skill => skill.name).join(',')}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${bot} ${error.message}`)
  }
}
console.log(`bots ${Object.keys(botLists).length} failures ${failures}`)
process.stdout.write('\n===APPLIED_JSON===\n' + JSON.stringify(applied, null, 2) + '\n')
await ctx.fiber.dispose()
process.exit(failures === 0 ? 0 : 1)
