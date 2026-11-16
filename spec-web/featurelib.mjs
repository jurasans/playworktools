// Feature modules (docs/spec/feature-modules.md): one folder per feature under documentation/features/<id>/.
// Pure file I/O, no HTTP, shared by server.mjs, tools/spec/feature.mjs and tools/spec/agent-run.mjs.
//
//   feature.json   title, subtitle, visuals { src, scenes[] }
//   spec.md        the feature's own spec, edited by hand in spec-web or by a refine run
//   qa.json        questions, notes, timeline, work items sent to the product spec
import { mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { atomicWriteFile } from './fs-safe.mjs'
import { diffHunks, diffStats, cleanName } from './workitems-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// SPEC_WEB_FEATURES_DIR keeps a test's features out of the real ones.
export const FEATURES_DIR = process.env.SPEC_WEB_FEATURES_DIR ? resolve(process.env.SPEC_WEB_FEATURES_DIR) : resolve(HERE, 'documentation', 'features')
const ID_RE = /^[a-z][a-z0-9-]{1,40}$/
export const validId = (id) => typeof id === 'string' && ID_RE.test(id)
const dir = (id) => resolve(FEATURES_DIR, id)
export const specFile = (id) => resolve(dir(id), 'spec.md')
const qaFile = (id) => resolve(dir(id), 'qa.json')
const metaFile = (id) => resolve(dir(id), 'feature.json')
const now = () => new Date().toISOString()
const norm = (t) => String(t).replace(/\r\n/g, '\n')
export const hashOf = (t) => createHash('sha1').update(t).digest('hex')
const MAX_TIMELINE = 300
const MAX_HUNK_LINES = 400

function write(file, text) { mkdirSync(dirname(file), { recursive: true }); atomicWriteFile(file, text) }
function readJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback } }
const emptyQa = () => ({ questions: [], notes: [], timeline: [], workItems: [], refine: null })

function need(id) {
  if (!validId(id) || !existsSync(metaFile(id))) throw new Error('No such feature.')
}

export function list() {
  if (!existsSync(FEATURES_DIR)) return []
  return readdirSync(FEATURES_DIR).filter((f) => validId(f) && existsSync(metaFile(f))).sort().map((id) => {
    const m = readJson(metaFile(id), {})
    return { id, title: m.title || id, subtitle: m.subtitle || '' }
  })
}

export function meta(id) {
  need(id)
  const m = readJson(metaFile(id), {})
  const src = typeof m.visuals?.src === 'string' && /^\/[^/\\]/.test(m.visuals.src) ? m.visuals.src : null
  const scenes = Array.isArray(m.visuals?.scenes) ? m.visuals.scenes.filter((s) => s && /^[a-z0-9-]+$/.test(s.id) && s.title).map((s) => ({ id: s.id, title: String(s.title), hint: s.hint ? String(s.hint) : '' })) : []
  // Extra tabs: a local page shown whole in an iframe. Same local-path rule as visuals so a feature file cannot frame another site.
  const pages = (Array.isArray(m.pages) ? m.pages : [])
    .filter((p) => p && /^[a-z0-9-]+$/.test(p.id) && p.title && typeof p.src === 'string' && /^\/[^/\\]/.test(p.src))
    .slice(0, 4).map((p) => ({ id: p.id, title: String(p.title).slice(0, 30), src: p.src }))
  return { id, title: m.title || id, subtitle: m.subtitle || '', visuals: src && scenes.length ? { src, scenes } : null, pages }
}

export const readSpec = (id) => { need(id); try { return readFileSync(specFile(id), 'utf8') } catch { return '' } }
export function readQa(id) { need(id); return { ...emptyQa(), ...readJson(qaFile(id), {}) } }
const saveQa = (id, qa) => { write(qaFile(id), JSON.stringify(qa, null, 2) + '\n'); return qa }

function addTimeline(qa, entry) {
  qa.timeline.push({ at: now(), ...entry })
  if (qa.timeline.length > MAX_TIMELINE) qa.timeline.splice(0, qa.timeline.length - MAX_TIMELINE)
}

/** A trimmed diff of two spec texts for the timeline: hunks capped so a rewrite cannot bloat qa.json. */
function diffFor(before, after) {
  const hunks = diffHunks(norm(before), norm(after))
  let n = 0
  const kept = []
  for (const h of hunks) {
    if (n >= MAX_HUNK_LINES) break
    kept.push({ ...h, lines: h.lines.slice(0, MAX_HUNK_LINES - n) })
    n += h.lines.length
  }
  return { hunks: kept, ...diffStats(hunks) }
}

/** What a person (or the refine run) typed counts only if the text really changed. Returns the timeline entry or null. */
function recordSpecChange(qa, before, after, by, kind, text) {
  if (norm(before) === norm(after)) return null
  const d = diffFor(before, after)
  const entry = { kind, by, text, added: d.added, removed: d.removed, hunks: d.hunks }
  addTimeline(qa, entry)
  return entry
}

/** Save the spec. `base` is the hash the editor loaded; a different hash means someone (or a run) changed it first. */
export function saveSpec(id, { content, base, by }) {
  need(id)
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are before saving.')
  if (typeof content !== 'string') throw new Error('content required')
  const current = readSpec(id)
  if (hashOf(current) !== base) { const e = new Error('The spec changed since you opened it. Reload and re-apply your edit.'); e.status = 409; throw e }
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const text = norm(content).replace(/\n/g, eol)
  const qa = readQa(id)
  recordSpecChange(qa, current, text, who, 'spec-edit', 'Edited the spec')
  write(specFile(id), text)
  saveQa(id, qa)
  return { hash: hashOf(text) }
}

// ── questions and notes ──────────────────────────────────────────────────────
const nextN = (items) => (items.length ? Math.max(...items.map((x) => x.n)) + 1 : 1)

// Possible answers are suggestions a person can click to fill the answer box; they never count as an answer.
const MAX_OPTIONS = 8
const cleanOptions = (list) => (Array.isArray(list) ? list : []).map((o) => String(o || '').trim().slice(0, 300)).filter(Boolean).slice(0, MAX_OPTIONS)

export function addQuestion(id, { text, blocking = false, by = 'Claude', options = [] }) {
  const qa = readQa(id)
  const t = String(text || '').trim().slice(0, 600)
  if (!t) throw new Error('Write the question first.')
  const q = { n: nextN(qa.questions), text: t, blocking: !!blocking, by: cleanName(by) || 'someone', at: now(), options: cleanOptions(options), answer: null, answeredBy: null, answeredAt: null, appliedAt: null }
  qa.questions.push(q)
  addTimeline(qa, { kind: 'question', by: q.by, text: `Q${q.n}${q.blocking ? ' (blocking)' : ''}: ${t.slice(0, 160)}` })
  saveQa(id, qa)
  return q
}

/** Replace the possible answers of a question (the question text and any answer stay as they are). */
export function setQuestionOptions(id, n, options, by = 'Claude') {
  const qa = readQa(id)
  const q = qa.questions.find((x) => x.n === Number(n))
  if (!q) throw new Error('No such question.')
  q.options = cleanOptions(options)
  addTimeline(qa, { kind: 'question', by: cleanName(by) || 'someone', text: `Q${q.n}: ${q.options.length} possible answer${q.options.length === 1 ? '' : 's'} listed` })
  saveQa(id, qa)
  return q
}

export function answerQuestion(id, n, text, by) {
  const qa = readQa(id)
  const q = qa.questions.find((x) => x.n === Number(n))
  if (!q) throw new Error('No such question.')
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are before answering.')
  const t = String(text || '').trim().slice(0, 2000)
  if (!t) throw new Error('Write the answer first.')
  q.answer = t; q.answeredBy = who; q.answeredAt = now(); q.appliedAt = null
  addTimeline(qa, { kind: 'answer', by: who, text: `A${q.n}: ${t.slice(0, 160)}` })
  saveQa(id, qa)
  return q
}

export function removeQuestion(id, n, by) {
  const qa = readQa(id)
  const i = qa.questions.findIndex((x) => x.n === Number(n))
  if (i < 0) throw new Error('No such question.')
  const [q] = qa.questions.splice(i, 1)
  addTimeline(qa, { kind: 'question-removed', by: cleanName(by) || 'someone', text: `Removed Q${q.n}` })
  saveQa(id, qa)
}

export function addNote(id, { text, by }) {
  const qa = readQa(id)
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are before adding a note.')
  const t = String(text || '').trim().slice(0, 4000)
  if (!t) throw new Error('Write the note first.')
  const note = { n: nextN(qa.notes), text: t, by: who, at: now(), appliedAt: null }
  qa.notes.push(note)
  addTimeline(qa, { kind: 'note', by: who, text: `Note ${note.n}: ${t.slice(0, 160)}` })
  saveQa(id, qa)
  return note
}

export function removeNote(id, n, by) {
  const qa = readQa(id)
  const i = qa.notes.findIndex((x) => x.n === Number(n))
  if (i < 0) throw new Error('No such note.')
  const [note] = qa.notes.splice(i, 1)
  addTimeline(qa, { kind: 'note-removed', by: cleanName(by) || 'someone', text: `Removed note ${note.n}` })
  saveQa(id, qa)
}

/** Answers and notes the spec has not been refined with yet: the input of the next "Update the spec" run. */
export function pending(qa) {
  return {
    answers: qa.questions.filter((q) => q.answer && !q.appliedAt),
    notes: qa.notes.filter((n) => !n.appliedAt),
  }
}

// ── refine run (Claude edits spec.md from the pending answers and notes) ─────
/** Remember which run does the update (the run is created after the snapshot, so the id arrives second). */
export function attachRefineRun(id, runId) {
  const qa = readQa(id)
  if (qa.refine?.status === 'running') { qa.refine.runId = runId; saveQa(id, qa) }
}

export function startRefine(id, by, runId = null) {
  const qa = readQa(id)
  const p = pending(qa)
  if (!p.answers.length && !p.notes.length) throw new Error('There are no new answers or notes to apply.')
  if (qa.refine && qa.refine.status === 'running') throw new Error('The spec is already being updated.')
  qa.refine = { status: 'running', runId, by: cleanName(by) || 'someone', startedAt: now(), before: readSpec(id), answers: p.answers.map((q) => q.n), notes: p.notes.map((n) => n.n) }
  addTimeline(qa, { kind: 'refine-start', by: qa.refine.by, text: `Asked Claude to update the spec from ${p.answers.length} answer${p.answers.length === 1 ? '' : 's'} and ${p.notes.length} note${p.notes.length === 1 ? '' : 's'}` })
  saveQa(id, qa)
  return qa.refine
}

/** Run ended (or never started). A finished run marks its answers and notes applied and records the spec diff it produced. */
export function finishRefine(id, status, summary = '') {
  const qa = readQa(id)
  const r = qa.refine
  if (!r || r.status !== 'running') return null
  const after = readSpec(id)
  const entry = recordSpecChange(qa, r.before, after, 'Claude', 'refine', status === 'done' ? (summary || 'Updated the spec from the answers and notes') : `Update ${status}`)
  if (status === 'done') {
    const at = now()
    for (const q of qa.questions) if (r.answers.includes(q.n)) q.appliedAt = at
    for (const n of qa.notes) if (r.notes.includes(n.n)) n.appliedAt = at
    if (!entry) addTimeline(qa, { kind: 'refine', by: 'Claude', text: 'Read the answers and notes; the spec needed no change' })
  } else if (!entry) {
    addTimeline(qa, { kind: 'refine-failed', by: 'Claude', text: `The update ${status}: ${String(summary).replace(/\s+/g, ' ').slice(0, 200) || 'no details'}` })
  }
  qa.refine = { ...r, before: undefined, status, finishedAt: now(), summary: String(summary).slice(0, 600) }
  saveQa(id, qa)
  return qa.refine
}

// ── turning the feature into a work item ─────────────────────────────────────
/** The text a new work item should treat as "what the person wrote": the part not already sent to the product spec. Work items `dropped` says are failed or cancelled do not count. */
export function workItemBaseline(id, dropped = () => false) {
  const qa = readQa(id)
  const last = [...qa.workItems].reverse().find((w) => w.text != null && !dropped(w.id))
  return last ? last.text : ''
}

export function linkWorkItem(id, { wi, by, text }) {
  const qa = readQa(id)
  qa.workItems.push({ id: wi, by: cleanName(by), at: now(), text })
  addTimeline(qa, { kind: 'work-item', by: cleanName(by), text: `Turned the spec into work item ${wi}`, workItem: wi })
  saveQa(id, qa)
}

export function view(id) {
  const m = meta(id)
  const qa = readQa(id)
  const spec = readSpec(id)
  const p = pending(qa)
  const { refine } = qa
  return {
    ...m,
    spec, hash: hashOf(spec),
    questions: qa.questions, notes: qa.notes,
    timeline: [...qa.timeline].reverse(),
    workItems: qa.workItems.map(({ text, ...w }) => w),
    pending: { answers: p.answers.length, notes: p.notes.length },
    refine: refine ? { status: refine.status, runId: refine.runId, by: refine.by, startedAt: refine.startedAt, finishedAt: refine.finishedAt, summary: refine.summary } : null,
  }
}

/** Create the folder for a new feature (tools/spec/feature.mjs new). Never overwrites. */
export function scaffold(id, title, subtitle = '') {
  if (!validId(id)) throw new Error('The id must be lowercase letters, digits and dashes, starting with a letter.')
  if (existsSync(metaFile(id))) throw new Error(`Feature ${id} already exists.`)
  write(metaFile(id), JSON.stringify({ title, subtitle, visuals: null }, null, 2) + '\n')
  write(specFile(id), `# ${title}\n\n> What this feature is, in a sentence.\n\n## Behaviour\n\n## Rules\n\n## Open\n`)
  write(qaFile(id), JSON.stringify(emptyQa(), null, 2) + '\n')
}
