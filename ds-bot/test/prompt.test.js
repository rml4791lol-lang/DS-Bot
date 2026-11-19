import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/prompt.js'
import { fakeContext } from './fake-ctx.js'

function start() {
  const ctx = fakeContext()
  const bots = new Map([
    ['main', { name: 'Chief' }],
    ['worker', { name: 'Dev', instructions: 'Check files.' }],
  ])
  install({
    ctx,
    selfOf: id => id === 'group-worker' ? 'worker' : id,
    botOf: id => bots.get(id),
    roomOf: id => id === 'room' ? {} : undefined,
    isMain: id => id === 'main',
  })
  const prompt = id => ctx.sections.get('bot-identity').text({ agent: { id } })
  return { ctx, prompt }
}

const SECTION_TITLES = [
  '### 1. Identity and scope',
  '### 2. Work loop',
  '### 3. Evidence',
  '### 4. Stop rules',
  '### 5. Delivery',
  '### 6. Collaboration',
  '### 7. Memory',
  '### 8. Failure handling',
]

// 26 team rules and 10 Main Bot rules; a rendered prompt repeats no rule.
const RULE_COUNTS = { main: 40, worker: 29 }

test('Bots get the eight rule sections in order, with every rule exactly once', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const rules = [
    '- Only for a direct user request in your own chat that needs several steps: make your first tool call in the same response as your text. When the work will take more than a minute or two, open with one short sentence of what you are about to do; when that sentence would only repeat the request or the first command, start with the tool call instead. On long tasks, give brief factual updates only at meaningful milestones, then keep working. Never end with a promise in place of the work.',
    '- Do not narrate tool mechanics or system notices to the user: exit codes, "no output", "saved", a handoff note, a context or memory injection, a checkpoint, or the label you were given. That is plumbing. Report the result the user can act on, or nothing.',
    '- For "[Message from …]" or "[Reply from …]" messages, do not write plans or progress updates: use tools silently, then reply with the answer. Simple answers do not need progress messages.',
    '- When a task clearly matches a skill in your skill catalog, call `skill` with that skill\'s name before you act, instead of re-deriving the guidance it already carries.',
    '- In a group chat, the group sees what you write while you work, not only your final reply. For work that takes more than a quick look, start with one short sentence on what you will do, in the same response as your first tool call. After that, write only when you find something the group should know or finish a part of the work, in a sentence or two, not at every step. End with the result. Simple answers need no updates. If the user is in the group, those visible lines are a result they can use or a decision they must make, not a work log.',
  ]
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    const lines = text.split('\n')
    for (const rule of rules) {
      assert.ok(lines.includes(rule))
      assert.equal(text.split(rule).length - 1, 1)
    }
    for (const title of SECTION_TITLES) {
      assert.equal(lines.filter(line => line === title).length, 1)
    }
    const positions = SECTION_TITLES.map(title => lines.indexOf(title))
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
    const bullets = lines.filter(line => line.startsWith('- '))
    assert.equal(bullets.length, RULE_COUNTS[id])
    assert.equal(new Set(bullets).size, bullets.length)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

// 公开#1499: a Bot that is handed a saved path and finds `read` closed to a PDF has to know where to go next.
test('Bots are told how to open a PDF the user attached, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const rule = prompt(id).split('\n').filter(line => line.startsWith('- A file the user attaches reaches you as a saved path'))
    assert.equal(rule.length, 1)
    assert.match(rule[0], /read tool opens text files only/)
    assert.match(rule[0], /scanned or not/)
    assert.match(rule[0], /office skill/)
    assert.match(rule[0], /office_render/)
    assert.match(rule[0], /never answer only that the file cannot be read/)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})

// L1: a note that repeats a question the conversation already answered is not fresh work.
test('Bots are told not to redo a question this conversation already answered, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  for (const id of ['main', 'worker']) {
    const rule = prompt(id).split('\n').filter(line => line.startsWith('- A note or a message that repeats a question'))
    assert.equal(rule.length, 1)
    assert.match(rule[0], /this conversation already answered/)
    assert.match(rule[0], /same sender, same question/)
    assert.match(rule[0], /is not new work/)
    assert.match(rule[0], /points back to the earlier conclusion/)
    assert.match(rule[0], /genuinely still open/)
  }
  assert.equal(prompt('group-worker'), prompt('worker'))
})


// Human-facing layer: user-visible talk stays human; bot collaboration stays off-chat.
test('Bots are told to speak to the user in a human voice, once, in the shared prefix', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  const intent = '- Infer the user\'s intent from what they have already said and from the situation. If they already told you to keep going, finish the work, or step away, do not wait for them to repeat it or ask them to type a wake-up message.'
  const voice = '- When the user can see your message, talk like a person: lead with the point, keep it short, and do not write an engineering log. Do not lead with commit hashes, test IDs, stage numbers, or file paths unless the user asked for those details.'
  const speak = '- Speak to the user only when there is a result they can use, a decision they must make, or you cannot finish. Ask one concrete question at a time. Work between Bots stays in tools, private messages, and reports, not in the chat the user reads.'
  for (const id of ['main', 'worker']) {
    const text = prompt(id)
    const lines = text.split('\n')
    for (const rule of [intent, voice, speak]) {
      assert.ok(lines.includes(rule), rule)
      assert.equal(text.split(rule).length - 1, 1)
    }
    assert.match(text, /If the user is in the group, those visible lines are a result they can use or a decision they must make, not a work log/)
  }
  const mainOnly = '- When you report the team\'s work, say it in this same human voice. Do not paste a Bot\'s engineering notes into the user\'s chat.'
  assert.ok(prompt('main').split('\n').includes(mainOnly))
  assert.equal(prompt('main').split(mainOnly).length - 1, 1)
  assert.ok(!prompt('worker').includes(mainOnly))
  assert.equal(prompt('group-worker'), prompt('worker'))
})

test('the group relay and non-Bot sessions do not get progress instructions', (t) => {
  const { ctx, prompt } = start()
  t.after(() => ctx.dispose())
  assert.match(prompt('room'), /end your turn with an empty reply/)
  assert.doesNotMatch(prompt('room'), /progress|milestone/)
  assert.equal(prompt('outside'), '')
})
