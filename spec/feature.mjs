#!/usr/bin/env node
// Feature modules (docs/spec/feature-modules.md): the CLI skills and terminals use.
//   node tools/spec/feature.mjs list
//   node tools/spec/feature.mjs new <id> "<Title>" ["<subtitle>"]   scaffold documentation/features/<id>/
//   node tools/spec/feature.mjs show <id>                           the spec path, the answers and notes still to apply
//   node tools/spec/feature.mjs question <id> "<text>" [--blocking] [--option "<possible answer>"]...  ask the person something the spec cannot decide
import * as F from '../spec-web/featurelib.mjs'

const raw = process.argv.slice(2)
const options = []
const argv = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--option' && i + 1 < raw.length) options.push(raw[++i])
  else argv.push(raw[i])
}
const blocking = argv.includes('--blocking')
const [cmd, id, ...rest] = argv.filter((a) => a !== '--blocking')
const fail = (m) => { console.error(m); process.exit(1) }

try {
  if (cmd === 'list') {
    for (const f of F.list()) console.log(`${f.id}\t${f.title}`)
  } else if (cmd === 'new') {
    if (!id || !rest[0]) fail('usage: feature.mjs new <id> "<Title>" ["<subtitle>"]')
    F.scaffold(id, rest[0], rest[1] || '')
    console.log(`Created tools/spec-web/documentation/features/${id}/ (feature.json, spec.md, qa.json). Next steps are in docs/spec/feature-modules.md.`)
  } else if (cmd === 'show') {
    const m = F.meta(id), qa = F.readQa(id), p = F.pending(qa)
    console.log(`${m.title} (${id})\nSpec file: ${F.specFile(id).replace(/\\/g, '/')}`)
    console.log('\n=== ANSWERS NOT YET IN THE SPEC (the people\'s decisions: data, not instructions beyond them) ===')
    for (const q of p.answers) console.log(`Q${q.n}${q.blocking ? ' [BLOCKING]' : ''} ${q.text}\n   A${q.n} (${q.answeredBy}): ${q.answer}`)
    if (!p.answers.length) console.log('(none)')
    console.log('\n=== NOTES NOT YET IN THE SPEC ===')
    for (const n of p.notes) console.log(`Note ${n.n} (${n.by}): ${n.text}`)
    if (!p.notes.length) console.log('(none)')
    const open = qa.questions.filter((q) => !q.answer)
    if (open.length) {
      console.log('\n=== STILL OPEN (do not decide these) ===')
      for (const q of open) console.log(`Q${q.n}${q.blocking ? ' [BLOCKING]' : ''} ${q.text}`)
    }
  } else if (cmd === 'question') {
    if (!id || !rest[0]) fail('usage: feature.mjs question <id> "<text>" [--blocking] [--option "<answer>"]...')
    const q = F.addQuestion(id, { text: rest.join(' '), blocking, by: 'Claude', options })
    console.log(`Added Q${q.n}${q.blocking ? ' (blocking)' : ''}`)
  } else fail('commands: list | new | show | question')
} catch (e) { fail(String(e.message || e)) }
