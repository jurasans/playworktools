// Work items (docs/spec/spec-work-items.md): the one path from a person's manual spec edit to a rewritten spec.
// Pure file I/O, no HTTP, shared by server.mjs, tools/spec/work.mjs and tools/spec/agent-run.mjs.
//
//   collecting   edits a person saved in spec-web (or claimed from git) pile up per document, baseline kept
//   WI-n         "I completed my changes" turns the pile into one work item
//   analyzing -> questions -> ready -> rewriting -> spec-review -> approved -> working -> in-qa -> done
//   (collected / failed / cancelled branch off). A person reviews and confirms the rewritten SPEC before any ticket is made.
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, existsSync, cpSync, rmSync } from 'node:fs'
import { resolve, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { atomicWriteFile } from './fs-safe.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..', '..')
// SPEC_WEB_WORK_DIR keeps a test's work items and collection out of the real ones.
export const WORK_DIR = process.env.SPEC_WEB_WORK_DIR ? resolve(process.env.SPEC_WEB_WORK_DIR) : resolve(HERE, 'documentation', 'work-items')
const COLLECT_FILE = process.env.SPEC_WEB_WORK_DIR ? resolve(WORK_DIR, '_collecting.json') : resolve(HERE, 'documentation', 'state', 'collecting.json')
const BEFORE_DIR = (id) => resolve(process.env.SPEC_WEB_WORK_DIR ? WORK_DIR : resolve(HERE, 'documentation', 'state'), 'work-before', id)
export const CHANGELOG_FILE = process.env.SPEC_WEB_WORK_DIR ? resolve(WORK_DIR, '_changelog.md') : resolve(ROOT, 'docs', 'history', 'spec-changes.md')

export const STATUSES = ['collected', 'analyzing', 'questions', 'ready', 'rewriting', 'spec-review', 'approved', 'working', 'in-qa', 'done', 'failed', 'cancelled']
const ID_RE = /^WI-\d+$/
export const validId = (id) => typeof id === 'string' && ID_RE.test(id)

/** Display name safe to store and show: no angle brackets or control characters, at most 40 characters. */
export const cleanName = (raw) => (typeof raw === 'string' ? raw.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '')
const norm = (t) => String(t).replace(/\r\n/g, '\n')
const now = () => new Date().toISOString()

function atomicWrite(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  atomicWriteFile(file, text)
}

// ── diff ─────────────────────────────────────────────────────────────────────
/**
 * Line diff as hunks `{ aStart, bStart, lines: [{t: ' '|'-'|'+', s}] }` (1-based starts, `ctx` unchanged lines around
 * each change). Common head and tail are trimmed first so the LCS table only covers the edited middle.
 */
export function diffHunks(before, after, ctx = 2) {
  const a = norm(before).split('\n'), b = norm(after).split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail), bm = b.slice(head, b.length - tail)
  const ops = []
  for (let i = 0; i < head; i++) ops.push({ t: ' ', s: a[i] })
  if (am.length * bm.length > 4_000_000) {
    // Too large for a table: report the middle as one removed block and one added block.
    for (const s of am) ops.push({ t: '-', s })
    for (const s of bm) ops.push({ t: '+', s })
  } else {
    const n = am.length, m = bm.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = am[i] === bm[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && am[i] === bm[j]) { ops.push({ t: ' ', s: am[i] }); i++; j++ }
      else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) { ops.push({ t: '-', s: am[i] }); i++ }   // removals first, as in git
      else { ops.push({ t: '+', s: bm[j] }); j++ }
    }
  }
  for (let k = a.length - tail; k < a.length; k++) ops.push({ t: ' ', s: a[k] })

  const changed = ops.map((o, k) => (o.t !== ' ' ? k : -1)).filter((k) => k >= 0)
  const hunks = []
  let cur = null
  const aLine = [], bLine = []
  let ai = 1, bi = 1
  for (const o of ops) { aLine.push(ai); bLine.push(bi); if (o.t !== '+') ai++; if (o.t !== '-') bi++ }
  for (const k of changed) {
    const from = Math.max(0, k - ctx), to = Math.min(ops.length - 1, k + ctx)
    if (cur && from <= cur.to + 1) cur.to = Math.max(cur.to, to)
    else { cur = { from, to }; hunks.push(cur) }
  }
  return hunks.map((h) => ({ aStart: aLine[h.from], bStart: bLine[h.from], lines: ops.slice(h.from, h.to + 1) }))
}

export function diffStats(hunks) {
  let added = 0, removed = 0
  for (const h of hunks) for (const l of h.lines) { if (l.t === '+') added++; else if (l.t === '-') removed++ }
  return { added, removed }
}

// ── collecting ───────────────────────────────────────────────────────────────
function readCollect() {
  try { return JSON.parse(readFileSync(COLLECT_FILE, 'utf8')) } catch { return {} }
}
const writeCollect = (c) => atomicWrite(COLLECT_FILE, JSON.stringify(c, null, 2) + '\n')
const ckey = (domain, doc) => `${domain}:${doc}`

/**
 * A person saved `doc`. The first save of a document in this collection keeps its text as the baseline; later saves only move
 * `latest`, so the work item sees one net change however many times the person saved. Saving back to the baseline drops the entry.
 */
export function recordEdit({ domain, doc, title = doc, before, after, by }) {
  const c = readCollect()
  const k = ckey(domain, doc)
  const e = c[k] || { domain, doc, title, baseline: norm(before), by: [], firstAt: now() }
  e.latest = norm(after)
  e.lastAt = now()
  const who = cleanName(by)
  if (who && !e.by.includes(who)) e.by.push(who)
  if (e.latest === e.baseline) delete c[k]
  else c[k] = e
  writeCollect(c)
  return c[k] || null
}

/** The text a document had before the current round of edits started (null when nothing is being collected for it). */
export function baselineOf(domain, doc) {
  return readCollect()[ckey(domain, doc)]?.baseline ?? null
}

/** The pile of unfinished changes for a domain, with hunks and counts ready for display. */
export function collecting(domain) {
  return Object.values(readCollect()).filter((e) => e.domain === domain).map((e) => {
    const hunks = diffHunks(e.baseline, e.latest)
    return { domain: e.domain, doc: e.doc, title: e.title, by: e.by, firstAt: e.firstAt, lastAt: e.lastAt, hunks, ...diffStats(hunks) }
  })
}

/** Edits made outside spec-web (an editor, git): take each document's difference from HEAD as a person's edit. */
export function collectFromGit({ domain, docs, by }) {
  const c = readCollect()
  const added = []
  for (const d of docs) {
    if (c[ckey(domain, d.key)]) continue
    const rel = relative(ROOT, d.path).split(sep).join('/')
    let head
    try { head = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { continue }
    const now_ = readFileSync(d.path, 'utf8')
    if (norm(head) === norm(now_)) continue
    recordEdit({ domain, doc: d.key, title: d.title, before: head, after: now_, by })
    added.push(d.key)
  }
  return added
}

// ── work items ───────────────────────────────────────────────────────────────
const wiFile = (id) => resolve(WORK_DIR, `${id}.json`)
export function get(id) {
  if (!validId(id)) return null
  try { return JSON.parse(readFileSync(wiFile(id), 'utf8')) } catch { return null }
}
function put(wi) { atomicWrite(wiFile(wi.id), JSON.stringify(wi, null, 2) + '\n'); return wi }
function log(wi, text) { wi.log.push({ at: now(), text: String(text).slice(0, 300) }); if (wi.log.length > 200) wi.log.splice(0, wi.log.length - 200) }
const num = (id) => Number(id.slice(3))

export function list(domain) {
  if (!existsSync(WORK_DIR)) return []
  return readdirSync(WORK_DIR).filter((f) => ID_RE.test(f.replace(/\.json$/, ''))).map((f) => get(f.slice(0, -5))).filter(Boolean)
    .filter((w) => !domain || w.domain === domain).sort((a, b) => num(b.id) - num(a.id))
}

function nextId() {
  const ids = existsSync(WORK_DIR) ? readdirSync(WORK_DIR).map((f) => /^WI-(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])) : []
  return 'WI-' + ((ids.length ? Math.max(...ids) : 0) + 1)
}

const unansweredBlocking = (wi) => wi.questions.filter((q) => q.blocking && !q.answer)
export const openQuestions = (wi) => wi.questions.filter((q) => !q.answer)

/** Status that follows from the questions: blocked, or ready for the spec rewrite, or (spec already confirmed) ready to start working. */
function settle(wi) {
  if (['questions', 'ready'].includes(wi.status)) wi.status = unansweredBlocking(wi).length ? 'questions' : (wi.specApprovedAt ? 'approved' : 'ready')
}

/** "I completed my changes": the collected pile for this domain becomes work item WI-n. */
export function createFromCollection({ domain, by, title = '' }) {
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are first.')
  const c = readCollect()
  const mine = Object.values(c).filter((e) => e.domain === domain)
  if (!mine.length) throw new Error('There are no changes to collect. Edit the spec first, or use "Detect edits made outside spec-web".')
  const changes = mine.map((e) => {
    const hunks = diffHunks(e.baseline, e.latest)
    return { doc: e.doc, title: e.title, by: e.by, hunks, ...diffStats(hunks) }
  })
  const id = nextId()
  const wi = {
    id, domain, status: 'collected', title: String(title).trim().slice(0, 120) || autoTitle(changes), createdBy: who, createdAt: now(),
    changes, analysis: null, questions: [], stubIds: [], commits: [], runs: {}, qaReport: null, log: [], sentBack: null,
  }
  log(wi, `${who} completed ${changes.length} document change${changes.length === 1 ? '' : 's'}`)
  put(wi)
  for (const e of mine) delete c[ckey(e.domain, e.doc)]
  writeCollect(c)
  return wi
}

function autoTitle(changes) {
  const first = changes[0]
  const line = first.hunks.flatMap((h) => h.lines).find((l) => l.t === '+' && l.s.trim() && !/^\s*[|#>-]*\s*$/.test(l.s))
  const text = (line?.s || first.title).replace(/^[\s#>*\-+\d.]+/, '').replace(/[`*_]/g, '').trim()
  return (changes.length > 1 ? `${text.slice(0, 80)} (+${changes.length - 1} more)` : text.slice(0, 100)) || 'Spec change'
}

export function attachRun(id, kind, runId) {
  const wi = get(id)
  if (!wi) return null
  wi.runs[kind] = runId
  if (kind === 'analyze') { wi.status = 'analyzing'; wi.lastError = null; log(wi, 'Claude started analyzing the spec against these changes') }
  put(wi)
  return wi
}

/** Claude's analysis: what the change touches, what conflicts, and the questions a person must answer. */
export function setAnalysis(id, a) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (!['collected', 'analyzing', 'failed'].includes(wi.status)) throw new Error(`${id} is ${wi.status}; analysis can only be stored before the questions are answered`)
  const arr = (x) => (Array.isArray(x) ? x : [])
  wi.analysis = {
    summary: String(a.summary || '').trim().slice(0, 3000),
    impact: arr(a.impact).map((i) => ({ file: String(i.file || '').slice(0, 200), sections: String(i.sections || '').slice(0, 300), why: String(i.why || '').slice(0, 600) })).filter((i) => i.file),
    conflicts: arr(a.conflicts).map((x) => String(typeof x === 'string' ? x : x.text || '').slice(0, 600)).filter(Boolean),
    codeGaps: arr(a.codeGaps).map((x) => String(typeof x === 'string' ? x : x.text || '').slice(0, 600)).filter(Boolean),
    // Text the person put where it does not belong, and where it should go (the spec rewrite moves it before any ticket exists).
    moves: arr(a.moves).map((m) => ({ from: String(m.from || '').slice(0, 300), to: String(m.to || '').slice(0, 300), what: String(m.what || '').slice(0, 400) })).filter((m) => m.from && m.to),
    // Edits that only describe what is already built and behaves as its stub says: documentation, committed as such, never built.
    nonChanges: arr(a.nonChanges).map((i) => ({ file: String(i.file || '').slice(0, 200), sections: String(i.sections || '').slice(0, 300), evidence: String(i.evidence || '').slice(0, 600) })).filter((i) => i.file),
    at: now(),
  }
  if (!wi.analysis.summary) throw new Error('analysis needs a summary')
  wi.questions = []
  arr(a.questions).forEach((q, i) => {
    const text = String(typeof q === 'string' ? q : q.text || '').trim()
    if (text) wi.questions.push({ n: i + 1, blocking: typeof q === 'object' && q.blocking === true, text: text.slice(0, 1200), answer: null })
  })
  wi.status = unansweredBlocking(wi).length ? 'questions' : 'ready'
  log(wi, `Claude's analysis: ${wi.analysis.impact.length} file(s) affected, ${wi.analysis.nonChanges.length} documentation-only, ${wi.questions.length} question(s) (${unansweredBlocking(wi).length} blocking)`)
  return put(wi)
}

/** A new question, from the analysis or from a run that finds something it cannot decide (the spec rewrite or the development). */
export function addQuestion(id, text, blocking) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  const t = String(text).trim()
  if (!t) throw new Error('question text is empty')
  const n = wi.questions.length ? Math.max(...wi.questions.map((q) => q.n)) + 1 : 1
  wi.questions.push({ n, blocking: !!blocking, text: t.slice(0, 1200), answer: null })
  if (['rewriting', 'working'].includes(wi.status) && blocking) { wi.status = 'questions'; log(wi, `The run stopped on blocking question Q${n}`) }
  else settle(wi)
  put(wi)
  return n
}

export function answer(id, n, text, by) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (!['questions', 'ready', 'collected', 'analyzing', 'spec-review', 'approved'].includes(wi.status)) throw new Error(`${id} is ${wi.status}; its questions are closed`)
  const q = wi.questions.find((x) => x.n === Number(n))
  if (!q) throw new Error(`${id} has no Q${n}`)
  const a = String(text).replace(/\s*\n\s*/g, ' ').trim()
  if (!a) throw new Error('Write an answer first.')
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are first.')
  q.answer = a.slice(0, 2000); q.answeredBy = who; q.answeredAt = now()
  log(wi, `${who} answered Q${q.n}`)
  settle(wi)
  return put(wi)
}

/**
 * Step 1 of the work: rewrite the spec text (move, reformat and cross-reference what the person wrote). No ticket exists yet.
 * Blocking questions must be answered first; optional ones are asked but never hold it back. The pre-rewrite copies of the spec
 * files are taken once (the person's own text) and kept, so every later pass is still reviewed against what they wrote.
 */
export function startRewrite(id, by, specFiles = []) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (wi.status !== 'ready') throw new Error(unansweredBlocking(wi).length ? `${id} still has ${unansweredBlocking(wi).length} blocking question(s).` : `${id} is ${wi.status}, not ready for the spec rewrite.`)
  const dir = BEFORE_DIR(id)
  if (!existsSync(dir)) {
    for (const f of specFiles) {
      const rel = relative(ROOT, f).split(sep).join('/')
      try { mkdirSync(dirname(resolve(dir, rel)), { recursive: true }); cpSync(f, resolve(dir, rel)) } catch { /* a file that is gone has nothing to compare */ }
    }
  }
  wi.status = 'rewriting'
  wi.rewriteStartedAt = now()
  wi.rewrittenBy = cleanName(by) || wi.rewrittenBy || null
  log(wi, `${wi.rewrittenBy || 'someone'} started the spec rewrite${wi.specFeedback ? ' (again, with the review comments)' : ''}`)
  return put(wi)
}

/** The rewrite run is finished: the person now reviews the new spec text. */
export function markSpecReview(id) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (wi.status !== 'rewriting') throw new Error(`${id} is ${wi.status}, not rewriting`)
  wi.status = 'spec-review'
  wi.specReviewAt = now()
  log(wi, 'The spec rewrite is finished and waiting for review')
  return put(wi)
}

/** The person read the rewritten spec and confirms it: only now can the work start. */
export function approveSpec(id, by) {
  const wi = get(id)
  if (!wi || wi.status !== 'spec-review') throw new Error('Only a spec waiting for review can be confirmed.')
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are first.')
  wi.status = 'approved'; wi.specApprovedAt = now(); wi.specApprovedBy = who; wi.specFeedback = null
  log(wi, `${who} confirmed the rewritten spec`)
  return put(wi)
}

/** The person wants the rewrite changed: it goes back to ready with the comment, for another rewrite pass. */
export function requestSpecChanges(id, reason, by) {
  const wi = get(id)
  if (!wi || wi.status !== 'spec-review') throw new Error('Only a spec waiting for review can be sent back.')
  const r = String(reason || '').trim()
  if (!r) throw new Error('Say what should change.')
  wi.status = 'ready'
  wi.specFeedback = { by: cleanName(by) || 'someone', reason: r.slice(0, 2000), at: now() }
  log(wi, `${wi.specFeedback.by} asked for changes to the rewritten spec: ${wi.specFeedback.reason}`)
  return put(wi)
}

/** Step 2 (after the spec is confirmed): tickets, development, verification. */
export function startWork(id, by) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (wi.status !== 'approved') throw new Error(`${id} is ${wi.status}; confirm the rewritten spec first.`)
  wi.status = 'working'
  wi.workStartedAt = now()
  wi.workedBy = cleanName(by) || wi.workedBy || null
  log(wi, `${wi.workedBy || 'someone'} started the work${wi.sentBack ? ' (rework)' : ''}`)
  return put(wi)
}

/** Spec files that differ from their pre-rewrite copy (the person's own text): what the rewrite changed. */
export function integrationDiff(id) {
  const wi = get(id)
  if (!wi) return []
  const dir = BEFORE_DIR(id)
  if (!existsSync(dir)) return []
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name)
      if (e.isDirectory()) { walk(p); continue }
      const rel = relative(dir, p).split(sep).join('/')
      let now_ = null
      try { now_ = readFileSync(resolve(ROOT, rel), 'utf8') } catch { /* deleted */ }
      const was = readFileSync(p, 'utf8')
      if (now_ === null || norm(was) !== norm(now_)) {
        const hunks = now_ === null ? [] : diffHunks(was, now_)
        out.push({ file: rel, deleted: now_ === null, ...diffStats(hunks), hunks })
      }
    }
  }
  walk(dir)
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

export function linkStubs(id, stubIds) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  wi.stubIds = [...new Set([...wi.stubIds, ...stubIds])]
  log(wi, `stubs: ${stubIds.join(', ')}`)
  return put(wi)
}

export const COMMIT_KINDS = ['docs', 'spec', 'feature', 'fix', 'registry']

/**
 * The integration run commits its work in an orderly series and records each commit here, so the work item shows the history:
 * `docs` (already-built behaviour written down), `spec` (the rewrite), `feature` (one per stub), `fix` (after a failed check or a
 * send back) and `registry` (stub statuses and the QA report).
 */
export function addCommit(id, sha, kind, subject) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha))) throw new Error('commit needs a git sha (7 to 40 hex characters)')
  if (!COMMIT_KINDS.includes(kind)) throw new Error(`commit kind must be one of ${COMMIT_KINDS.join(', ')}`)
  const sub = String(subject || '').trim().slice(0, 200)
  if (!sub) throw new Error('commit needs a subject line')
  wi.commits = wi.commits || []
  if (wi.commits.some((c) => c.sha === String(sha).toLowerCase())) return wi
  wi.commits.push({ sha: String(sha).toLowerCase(), kind, subject: sub, at: now() })
  log(wi, `commit ${String(sha).slice(0, 7)} (${kind}): ${sub}`)
  return put(wi)
}

export function progress(id, text) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  log(wi, text)
  return put(wi)
}

export function setQaReport(id, text) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  wi.qaReport = String(text).trim().slice(0, 4000)
  return put(wi)
}

/** Claude marks the work item ready for a person's QA once the stubs are in-qa and the full verification is green. */
export function markInQa(id) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (wi.status !== 'working') throw new Error(`${id} is ${wi.status}, not working`)
  wi.status = 'in-qa'
  wi.integratedAt = now()
  log(wi, 'The work is finished, waiting for QA')
  return put(wi)
}

// A usage/session limit is not a defect of the work: say so, and that retrying continues the same step (the confirmed spec and tickets are kept).
function failureReason(what, status, summary) {
  const limit = /(session|usage|rate) limit[^\n]*/i.exec(String(summary || ''))
  return limit ? `${what} stopped at the model's usage limit (${limit[0].trim()}). Retry continues this step once the limit has reset.` : `${what} ${status}.`
}

/** The site banner when it asks a person to act ("human") for this work item, else null. */
export function humanBanner(id) {
  try {
    const s = JSON.parse(readFileSync(resolve(ROOT, 'tools', 'spec-web', '.data', 'session-state.json'), 'utf8'))
    return s.state === 'human' && s.workItem === id ? s : null
  } catch { return null }
}

/** The person did what the banner asked: the work item is ready for its develop run to continue where it stopped. */
export function resumeWork(id, by) {
  const wi = get(id)
  if (!wi || wi.status !== 'working' || !wi.waitingHuman) throw new Error(`${id} is not waiting for a person.`)
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are first.')
  log(wi, `${who} resumed the run`)
  wi.waitingHuman = null
  return put(wi)
}

/** The worker calls these when a run ends, so a crashed or silent run never leaves a work item stuck. */
export function runFinished(id, kind, status, summary) {
  const wi = get(id)
  if (!wi) return null
  if (kind === 'analyze' && wi.status === 'analyzing') {
    wi.status = 'collected'
    wi.lastError = status === 'done' ? 'Claude finished without storing an analysis.' : `The analysis run ${status}.`
    log(wi, wi.lastError)
  }
  if (kind === 'respec' && wi.status === 'rewriting') {
    if (status === 'done') { wi.status = 'spec-review'; wi.specReviewAt = now(); log(wi, 'The spec rewrite run finished (moved to review)') }
    else { wi.status = 'failed'; wi.failedPhase = 'rewrite'; wi.lastError = failureReason('The spec rewrite run', status, summary); log(wi, wi.lastError) }
  }
  // A run that ended on purpose to wait for a person (banner state "human" naming this work item) is paused, not finished.
  if (kind === 'develop' && wi.status === 'working' && status === 'done' && humanBanner(id)) {
    wi.waitingHuman = { note: humanBanner(id).note || '', at: now() }
    log(wi, 'The run stopped to wait for a person: ' + (wi.waitingHuman.note || 'see the banner').split('\n')[0].slice(0, 160))
  } else if (kind === 'develop' && wi.status === 'working') {
    if (status === 'done') { wi.status = 'in-qa'; wi.integratedAt = now(); log(wi, 'The development run finished (no explicit hand-over, moved to QA)') }
    else { wi.status = 'failed'; wi.failedPhase = 'work'; wi.lastError = failureReason('The development run', status, summary); log(wi, wi.lastError) }
  }
  if (summary) wi.runSummary = String(summary).slice(0, 2000)
  return put(wi)
}

/** A person tried the result and is happy: the work item is done (the caller moves its stubs to done). */
export function confirmDone(id, by) {
  const wi = get(id)
  if (!wi || wi.status !== 'in-qa') throw new Error('Only a work item in QA can be confirmed.')
  const who = cleanName(by)
  if (!who) throw new Error('Say who you are first.')
  wi.status = 'done'; wi.doneBy = who; wi.doneAt = now()
  log(wi, `${who} confirmed it done`)
  put(wi)
  try { logDone(wi) } catch { /* the history line is a record, never a reason to refuse */ }
  rmSync(BEFORE_DIR(id), { recursive: true, force: true })
  return wi
}

/** QA found a problem: back to approved (the spec stays confirmed) with the reason, for another work pass on the same stubs. */
export function sendBack(id, reason, by) {
  const wi = get(id)
  if (!wi || wi.status !== 'in-qa') throw new Error('Only a work item in QA can be sent back.')
  const r = String(reason || '').trim()
  if (!r) throw new Error('Say what is wrong.')
  wi.status = 'approved'
  wi.sentBack = { by: cleanName(by) || 'someone', reason: r.slice(0, 1000), at: now() }
  wi.qaReport = null
  log(wi, `${wi.sentBack.by} sent it back: ${wi.sentBack.reason}`)
  return put(wi)
}

export function cancel(id, by) {
  const wi = get(id)
  if (!wi || !['collected', 'questions', 'ready', 'spec-review', 'approved', 'failed'].includes(wi.status)) throw new Error('Only a work item that is not running or in QA can be cancelled.')
  wi.status = 'cancelled'
  log(wi, `${cleanName(by) || 'someone'} cancelled it`)
  return put(wi)
}

/** After a failed run, a person may retry from the step that failed (the answers and the confirmed spec are kept). */
export function retry(id) {
  const wi = get(id)
  if (!wi || wi.status !== 'failed' || !wi.analysis) throw new Error('Only a failed work item with an analysis can be retried.')
  wi.status = unansweredBlocking(wi).length ? 'questions' : (wi.failedPhase === 'work' && wi.specApprovedAt ? 'approved' : 'ready')
  wi.failedPhase = null
  wi.lastError = null
  return put(wi)
}

export const REDO_STEPS = ['analysis', 'rewrite', 'work']

/**
 * Redo a step: put the work item back at the start of `analysis`, `rewrite` or `work` so its normal button runs again. It works
 * on a finished, failed or stuck step (the caller stops a run that is still going first). Going back to `analysis` drops the
 * analysis and its questions (the old ones are kept in `previousQuestions` for reference); `rewrite` needs an analysis and no
 * tickets yet; `work` needs a confirmed spec and keeps the tickets, so the next pass reworks them.
 */
export function resetToStep(id, step, by) {
  const wi = get(id)
  if (!wi) throw new Error(`no work item ${id}`)
  if (!REDO_STEPS.includes(step)) throw new Error(`step must be one of ${REDO_STEPS.join(', ')}`)
  if (['done', 'cancelled'].includes(wi.status)) throw new Error(`${id} is ${wi.status}; there is nothing to redo.`)
  const who = cleanName(by) || 'someone'
  if (step === 'analysis') {
    wi.previousQuestions = wi.questions
    wi.analysis = null; wi.questions = []; wi.specApprovedAt = null; wi.specFeedback = null
    wi.status = 'collected'
  } else if (step === 'rewrite') {
    if (!wi.analysis) throw new Error('There is no analysis yet: run the analysis first.')
    if (wi.stubIds.length || ['working', 'in-qa'].includes(wi.status)) throw new Error('Tickets already exist, so the spec rewrite cannot be redone; send the work back or redo the work instead.')
    wi.specApprovedAt = null; wi.specFeedback = null
    wi.status = unansweredBlocking(wi).length ? 'questions' : 'ready'
  } else {
    if (!wi.specApprovedAt) throw new Error('The spec has not been confirmed yet, so there is no work to redo.')
    wi.status = unansweredBlocking(wi).length ? 'questions' : 'approved'
  }
  wi.lastError = null; wi.failedPhase = null
  log(wi, `${who} redid the step: ${step}`)
  return put(wi)
}

function logDone(wi) {
  const day = wi.doneAt.slice(0, 16).replace('T', ' ')
  const files = [...new Set(wi.changes.map((c) => c.doc))].join(', ')
  const line = `- ${day} · ${wi.id} · ${files} · ${wi.title} · by ${wi.createdBy}, QA by ${wi.doneBy}${wi.stubIds.length ? ` · ${wi.stubIds.join(' ')}` : ''}\n`
  let text = ''
  try { text = readFileSync(CHANGELOG_FILE, 'utf8') } catch { /* first entry */ }
  if (!text) text = '# Spec changes log\n\nOne line per work item (docs/spec/spec-work-items.md): a person changed the spec, Claude rewrote it and a person confirmed the rewritten spec, Claude then built it, and a person confirmed it done after QA, newest last.\n\n'
  atomicWrite(CHANGELOG_FILE, text + line)
}

/** Lightweight row for lists and the top bar. */
export function summary(wi) {
  return {
    id: wi.id, domain: wi.domain, title: wi.title, status: wi.status, createdBy: wi.createdBy, createdAt: wi.createdAt,
    waitingHuman: wi.waitingHuman || null, docs: wi.changes.map((c) => c.doc), blocking: unansweredBlocking(wi).length, open: openQuestions(wi).length, stubIds: wi.stubIds,
  }
}
