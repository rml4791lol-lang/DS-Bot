// A Bot's skill shortlist: at most five named skills with one line each, shown in the
// Bot's prompt by name only, and a fallback that keeps a Bot from guessing at a skill.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { catalogEntries, catalogSignature, validateShortlistAgainstCatalog } from '../src/host/skill-catalog.js'
import { SKILL_SHORTLIST_FALLBACK, SKILL_SHORTLIST_MAX, readSkillShortlist, skillShortlistSection } from '../src/host/skill-shortlist.js'
import { fakeContext } from './fake-ctx.js'

const entry = (name, purpose = `use ${name}`) => ({ name, purpose })

test('a shortlist takes up to five skills and clears with an empty list', () => {
  const five = ['a11y-audit', 'code-review-and-quality', 'test-driven-development', 'ppt-studio', 'zh-tdd'].map(name => entry(name))
  assert.equal(readSkillShortlist(undefined), undefined)
  assert.deepEqual(readSkillShortlist([]), [])
  assert.deepEqual(readSkillShortlist(five).map(skill => skill.name), five.map(skill => skill.name))
  assert.equal(readSkillShortlist(five).length, SKILL_SHORTLIST_MAX)
})

test('a sixth skill is rejected instead of dropped silently', () => {
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => entry(name))
  assert.throws(() => readSkillShortlist(six), /at most 5 skills/)
})

test('an entry must name a skill once and say when to use it', () => {
  assert.throws(() => readSkillShortlist([entry('a'), entry('a')]), /lists a twice/)
  assert.throws(() => readSkillShortlist([entry('Not A Skill')]), /must be a skill name/)
  assert.throws(() => readSkillShortlist([{ name: 'a', purpose: '   ' }]), /says when to use a/)
  assert.deepEqual(readSkillShortlist([{ name: 'a', purpose: 'first\n  second' }])[0].purpose, 'first second')
  assert.throws(() => readSkillShortlist([entry('a', 'x'.repeat(161))]), /at most 160 characters/)
  assert.throws(() => readSkillShortlist(['a']), /must be an object/)
  assert.throws(() => readSkillShortlist('a'), /must be a list/)
})

test('the prompt lists names and one line each, then the fallback', () => {
  const list = readSkillShortlist([
    { name: 'test-driven-development', purpose: 'write the failing test before the fix' },
    { name: 'ppt-studio', purpose: 'build or edit a slide deck' },
  ])
  const section = skillShortlistSection(list)
  assert.match(section, /^## Your skill shortlist$/m)
  assert.match(section, /^- test-driven-development: write the failing test before the fix$/m)
  assert.match(section, /^- ppt-studio: build or edit a slide deck$/m)
  assert.equal(section.split(SKILL_SHORTLIST_FALLBACK).length - 1, 1)
  // Progressive disclosure: no SKILL.md body reaches the prompt.
  assert.doesNotMatch(section, /<skill|Instructions|## When to use/i)
})

test('a Bot without a shortlist reads exactly as before', (t) => {
  const ctx = fakeContext()
  const bots = new Map([
    ['bare', { name: 'Bare' }],
    ['listed', { name: 'Listed', skillShortlist: readSkillShortlist([entry('zh-tdd')]) }],
  ])
  install({
    ctx,
    selfOf: id => id,
    botOf: id => bots.get(id),
    roomOf: () => undefined,
    isMain: () => false,
  })
  t.after(() => ctx.dispose())
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  const bare = prompt('bare')
  assert.doesNotMatch(bare, /Your skill shortlist/)
  assert.doesNotMatch(bare, new RegExp(SKILL_SHORTLIST_FALLBACK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const listed = prompt('listed')
  assert.match(listed, /^## Your skill shortlist$/m)
  assert.match(listed, /^- zh-tdd: use zh-tdd$/m)
  assert.equal(listed.split(SKILL_SHORTLIST_FALLBACK).length - 1, 1)
  // The rules stay above the shortlist, so the cached prefix keeps its shape.
  assert.ok(listed.indexOf('### 1. Identity and scope') < listed.indexOf('## Your skill shortlist'))
})

test('the catalog merges providers by name and never exposes a masked entry', () => {
  const profile = [
    { name: 'test-driven-development', description: 'write the test first', provider: 'filesystem' },
    { name: 'systematic-debugging', description: 'find the root cause', provider: 'superpowers' },
    { name: 'hidden-by-another-bot', description: 'not a choice', invocation: { modelInvocable: false } },
  ]
  const capabilities = [{ name: 'team-review', description: 'review the diff' }]
  const catalog = catalogEntries(profile, capabilities)
  assert.deepEqual(catalog.map(skill => skill.name), ['systematic-debugging', 'team-review', 'test-driven-development'])
  assert.equal(catalog.find(skill => skill.name === 'team-review').provider, 'DS-Bot')
  assert.equal(catalog.find(skill => skill.name === 'test-driven-development').provider, 'filesystem')
})

test('validation enforces the shape and the live names in one place', () => {
  const catalog = catalogEntries([
    { name: 'test-driven-development', description: 'tdd' },
    // A symbolic-link provider entry still appears under its skill name.
    { name: 'systematic-debugging', description: 'debug' },
    { name: 'code-review-and-quality', description: 'review' },
    { name: 'ppt-studio', description: 'deck' },
    { name: 'zh-tdd', description: 'tdd in Chinese' },
  ])
  const five = ['test-driven-development', 'systematic-debugging', 'code-review-and-quality', 'ppt-studio', 'zh-tdd'].map(name => entry(name))
  assert.deepEqual(validateShortlistAgainstCatalog(five, catalog).map(skill => skill.name), five.map(skill => skill.name))
  assert.throws(() => validateShortlistAgainstCatalog([...five, entry('a11y-audit')], catalog), /at most 5 skills/)
  assert.throws(() => validateShortlistAgainstCatalog([entry('not-installed')], catalog), /No skill named not-installed/)
  assert.equal(validateShortlistAgainstCatalog([], catalog).length, 0)
})

test('mask reconciliation can see an already hidden profile entry without exposing it', () => {
  const profile = [
    { name: 'visible', description: 'visible' },
    { name: 'hidden', description: 'hidden', invocation: { modelInvocable: false } },
  ]
  assert.deepEqual(catalogEntries(profile).map(skill => skill.name), ['visible'])
  assert.deepEqual(catalogEntries(profile, [], { includeMasked: true }).map(skill => skill.name), ['hidden', 'visible'])
  assert.equal(catalogEntries(profile, [], { includeMasked: true }).find(skill => skill.name === 'hidden').modelInvocable, false)
})

test('catalog changes change the signature used by the live feed', () => {
  const one = catalogEntries([{ name: 'test-driven-development', description: 'tdd' }])
  const two = catalogEntries([{ name: 'test-driven-development', description: 'tdd' }, { name: 'systematic-debugging', description: 'debug' }])
  assert.notEqual(catalogSignature(one), catalogSignature(two))
})
