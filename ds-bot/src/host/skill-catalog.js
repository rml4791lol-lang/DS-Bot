// The skill names a Bot may choose from: DSH's own profile catalog plus the team's
// DS-Bot skill capabilities, merged and labelled by where each name comes from.
//
// This is deliberately a view over `ctx.skills.list()` / `snapshot()` rather than a
// directory scan: DSH merges several providers and follows symbolic links, so two
// installs with the same folders can still show different names.

import { readSkillShortlist } from './skill-shortlist.js'

export function catalogEntries(profile = [], capabilities = [], { includeMasked = false } = {}) {
  const merged = new Map()
  for (const skill of profile) {
    // Entries DSH hides from the model are execution-layer masks, not choices.
    // Mask reconciliation asks for them explicitly so an existing mask is not
    // mistaken for a missing profile skill and removed on the next pass.
    const modelInvocable = skill?.invocation?.modelInvocable !== false
    if (!includeMasked && !modelInvocable) continue
    if (typeof skill?.name !== 'string' || skill.name === '') continue
    merged.set(skill.name, {
      name: skill.name,
      description: String(skill.description ?? ''),
      provider: String(skill.provider ?? skill.source ?? 'DSH'),
      source: 'dsh',
      modelInvocable,
    })
  }
  for (const skill of capabilities) {
    if (typeof skill?.name !== 'string' || skill.name === '') continue
    merged.set(skill.name, {
      name: skill.name,
      description: String(skill.description ?? ''),
      provider: 'DS-Bot',
      source: 'capability',
      modelInvocable: true,
    })
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function validateShortlistAgainstCatalog(list, catalog) {
  if (list === undefined) return undefined
  // One gate for the saved shape (at most five, no duplicate, a usable name and
  // purpose) and for the live names, so a sixth entry is never silently dropped.
  const checked = readSkillShortlist(list)
  const names = new Set(catalog.map(skill => skill.name))
  for (const skill of checked) {
    if (!names.has(skill.name)) throw new Error(`No skill named ${skill.name} is available to this Bot.`)
  }
  return checked
}

export function catalogSignature(catalog) {
  return catalog.map(skill => `${skill.name}\0${skill.provider}\0${skill.description}\0${skill.modelInvocable !== false}\0${(skill.bots ?? []).join(',')}\0${JSON.stringify(skill.byBot ?? null)}`).join('\n')
}
