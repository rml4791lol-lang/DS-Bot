// A Bot's skill shortlist: at most five skills, each with one line saying when to use
// it. Only those names and lines reach the system prompt; a skill's own instructions
// stay in its SKILL.md until the Bot loads it with the `skill` tool.

export const SKILL_SHORTLIST_MAX = 5
export const SKILL_PURPOSE_MAX = 160
const NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/
const NAME_MAX = 64

// Reads the shortlist a caller asked to save. `undefined` leaves it untouched; an
// empty list clears it. Anything that would make the prompt unclear is rejected
// instead of trimmed, so a sixth skill never disappears silently.
export function readSkillShortlist(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('skills must be a list of { name, purpose }')
  if (value.length > SKILL_SHORTLIST_MAX) {
    throw new Error(`a Bot can keep at most ${SKILL_SHORTLIST_MAX} skills in its shortlist, not ${value.length}`)
  }
  const seen = new Set()
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`skills[${index}] must be an object with name and purpose`)
    }
    const name = String(entry.name ?? '').trim()
    if (name.length > NAME_MAX || !NAME.test(name)) {
      throw new Error(`skills[${index}].name must be a skill name such as "test-driven-development"`)
    }
    if (seen.has(name)) throw new Error(`the shortlist lists ${name} twice`)
    seen.add(name)
    const purpose = String(entry.purpose ?? '').replace(/\s+/g, ' ').trim()
    if (purpose === '') throw new Error(`skills[${index}].purpose is the one line that says when to use ${name}`)
    if (purpose.length > SKILL_PURPOSE_MAX) {
      throw new Error(`skills[${index}].purpose must be at most ${SKILL_PURPOSE_MAX} characters`)
    }
    return { name, purpose }
  })
}

export const SKILL_SHORTLIST_FALLBACK = 'If no skill in the shortlist matches the task, do the work the ordinary way; do not guess at a skill.'

// The prompt section for one Bot, or '' when it keeps no shortlist: Bots without one
// read exactly as they did before this section existed.
export function skillShortlistSection(list) {
  if (!Array.isArray(list) || list.length === 0) return ''
  return [
    '## Your skill shortlist',
    ...list.map(skill => `- ${skill.name}: ${skill.purpose}`),
    '',
    SKILL_SHORTLIST_FALLBACK,
  ].join('\n')
}
