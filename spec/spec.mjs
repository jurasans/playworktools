#!/usr/bin/env node
/**
 * spec.mjs — CLI for the SPEC_STUBS.md stub registry.
 *
 * SPEC_STUBS.md holds the whole stub-driven work queue for this project (the
 * index table plus every `### STUB:` write-up) and is ~4,500 lines on its own.
 * It used to live at the bottom of CLAUDE.md (still the project's single
 * source of truth for the prose spec + agent-operating rules) but was split
 * into its own file once it grew to dwarf that prose — see CLAUDE.md's own
 * *Spec Stubs* section and Key Rule 15. Editing SPEC_STUBS.md by hand (or with
 * ad-hoc sed/python one-liners) to flip a status or record an answer is how it
 * eventually gets corrupted — the status lives in TWO places that must stay in
 * lockstep (the index table near the top and the stub block far below), and
 * it is easy to update one and forget the other.
 *
 * Two file facts this tool is built around, both discovered by inspecting the
 * real bytes rather than assumed:
 *
 *   1. The file's line endings are detected on read (LF or CRLF, whichever is
 *      dominant) and restored on write, so a save never rewrites every line
 *      as a spurious diff over an EOL mismatch.
 *   2. `**Status:**` is frequently `done — <prose explaining the resolution>`,
 *      not a bare enum. Status is therefore the FIRST TOKEN, and any trailing
 *      prose is preserved verbatim on update.
 *
 * Usage:
 *   node tools/spec/spec.mjs list [status]        # default: deferred
 *   node tools/spec/spec.mjs show <id>
 *   node tools/spec/spec.mjs questions [id]       # unanswered questions
 *   node tools/spec/spec.mjs answer <id> <n> <text...>
 *   node tools/spec/spec.mjs enable <id> [--force]
 *   node tools/spec/spec.mjs defer <id>
 *   node tools/spec/spec.mjs check                # index/block status agreement
 *
 * Global flags: --dry-run (print the diff, write nothing)
 *
 * Run `node tools/spec/spec.mjs help` (or `--help` on any subcommand) for the
 * full command list.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Session state — a small, separate flag for "is someone actively mid-change
// on this repo right now", NOT stub content, so it deliberately does not
// live in SPEC_STUBS.md (which is reserved for the stub registry — see the
// file's own doc comment above). Read/written only via `spec state
// get`/`spec state set`, same "the CLI is the only writer" discipline as
// SPEC_STUBS.md itself, just for a different file — spec-web's server reads it
// back through this same CLI rather than touching the JSON directly, so
// there is exactly one place that knows this file's shape.
const STATE_FILE = resolve(ROOT, 'tools', 'spec-web', '.data', 'session-state.json')
const SESSION_STATES = ['wip', 'ready', 'human']
// SPEC_STUBS_FILE lets a caller point this same CLI at a different registry
// file in this repo — e.g. SPEC_STUBS_BACKEND.md, the playwork-backend repo's
// own stub queue (see its CLAUDE.md "Backend" section and its own
// backend-spec-planning skill, which always sets this env var). Defaults to
// the original SPEC_STUBS.md so every existing invocation is unaffected.
const SPEC = resolve(ROOT, process.env.SPEC_STUBS_FILE || 'SPEC_STUBS.md')

// 'delay' = parked indefinitely: a real, accepted item that is deliberately not
// being scheduled (the a11y batch is the founding case). It is deliberately NOT
// 'deferred' — deferred means "queued, will be worked", and every "what's left
// to do" view filters on that. Anything filtering `status === 'deferred'`
// (enable-ready, the questions default, the list default) therefore skips
// delayed stubs for free, which is the whole point.
//
// 'in-qa' sits between 'in-progress' and 'done': the implementer's own work is
// finished and self-verified (tsc/vitest/e2e green, spec write-up done) but a
// human has not yet confirmed it — 'done' is reserved for that confirmation.
// This is the status an agent should set on finishing a stub, NOT 'done'
// (which still requires --force as a reminder it is a stronger claim).
const STATUSES = ['deferred', 'delay', 'enabled', 'in-progress', 'in-qa', 'done']

// ── ANSI (skipped when not a TTY, so piping to a file stays clean) ────────────
const tty = process.stdout.isTTY
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s)
const bold = (s) => c(1, s)
const dim = (s) => c(2, s)
const red = (s) => c(31, s)
const green = (s) => c(32, s)
const yellow = (s) => c(33, s)
const cyan = (s) => c(36, s)
const magenta = (s) => c(35, s)
const blue = (s) => c(34, s)

function die(msg) {
  console.error(red(`✗ error: ${msg}`))
  process.exit(1)
}

/**
 * Collapses arbitrary user-typed text into the single physical line every
 * `> Qn: ...` / `> An: ...` / `- ...` entry in this file's format requires.
 *
 * Every write path that constructs one of those lines (`answer`, `question`,
 * `reopen`, `note`, and the `ask`/`import-answers` variants of `answer`)
 * used to splice the raw text straight into `doc.lines` with no such
 * collapsing. A `<textarea>` (the spec-web UI's answer/reopen boxes both use
 * one) or a multi-line CSV cell can easily contain a literal newline — once
 * that lands in `doc.lines`, `lines.join(eol)` turns it into GENUINE new raw
 * lines in SPEC_STUBS.md with no `> ` prefix on any but the first. On the next
 * parse, `qa()`'s `collect()` only recognizes lines matching `^>\s*[QA]\d+:`
 * inside a Q/A run (blank lines tolerated, anything else ends it) — so those
 * un-prefixed continuation lines read as ordinary body text sitting OUTSIDE
 * the Open Questions/Answers block, right after it, exactly like normal
 * prose. That is the "recording outside of the answer block" bug: the text
 * was never lost, it was simply never a valid part of the block to begin
 * with once it spanned more than one physical line.
 */
function toSingleLine(text) {
  return String(text).replace(/\s*\r?\n\s*/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

// ── Load ─────────────────────────────────────────────────────────────────────
function load() {
  let raw = readFileSync(SPEC, 'utf8')
  // Another writer (a second session, spec-web) may have the file emptied for a moment; wait it out rather than act on nothing.
  for (let i = 0; i < 10 && !raw.trim(); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    raw = readFileSync(SPEC, 'utf8')
  }
  if (!raw.trim()) throw new Error(`${SPEC} is empty; refusing to continue. Restore it with: git checkout HEAD -- SPEC_STUBS.md`)
  // Detect dominant EOL so the write path can restore it byte-for-byte.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n'
  return { lines: raw.split(/\r?\n/), eol }
}

function save({ lines, eol }, dryRun) {
  if (dryRun) return false
  const text = lines.join(eol)
  // An empty registry is never intended (it happened once: 6,445 lines lost to a truncating write). Replace atomically so a reader never sees a half-written file.
  if (!text.trim()) throw new Error('refusing to write an empty stub registry')
  const tmp = SPEC + '.tmp-' + process.pid
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, SPEC)
  return true
}

// ── Parse ────────────────────────────────────────────────────────────────────
// Index rows look like:  | S-154 | Some title | deferred |
// but the status cell ALSO frequently carries prose, exactly like the block's
// `**Status:**` does — e.g. `| S-47 | ... | done — part 1 verified correct; ... |`.
// So the row is split on cells rather than matched with a bare-enum regex
// (which silently matched nothing for the 18 stubs written that way), and the
// status is the first token of the last cell.
// A stub's id is normally bare (S-183), but a reopened stub carries a
// version letter (S-183-a, then S-183-b on a second reopen, …) — see
// `cmdReopen`/`nextReopenId`. Every regex that recognizes an id anywhere in
// the file (the index row, the stub heading, registerStubs' own heading
// scan) shares this one fragment so none of them can drift out of sync with
// what ids actually look like.
const ID_RE_FRAG = 'S-\\d+(?:-[a-z])?'
const INDEX_ROW_RE = new RegExp(`^\\|\\s*(${ID_RE_FRAG})\\s*\\|.*\\|\\s*$`)

/** Split a table row into cells. id is always cell 0 and status always the
 *  last, so a title containing a stray `|` cannot shift either of them. */
function indexCells(line) {
  const parts = line.split('|')
  // leading and trailing empties come from the row's own outer pipes
  const cells = parts.slice(1, -1).map((s) => s.trim())
  return { id: cells[0], title: cells.slice(1, -1).join(' | '), statusCell: cells[cells.length - 1] }
}
// Stub headings look like: ### STUB: S-154 — Title   (em dash, but be tolerant)
const STUB_RE = new RegExp(`^### STUB:\\s*(${ID_RE_FRAG})\\s*[—–-]\\s*(.*)$`)
// A reopened stub gets a SUB-STUB nested inside its own parent block, one
// heading level deeper (#### vs ###) — never a second top-level ### STUB
// entry of its own. See `cmdReopen`/`nextReopenId` for why: the point is to
// browse a stub's reopen history nested under the original, not scattered as
// unrelated-looking siblings in the index table (which sub-stubs never get a
// row in at all — they are pure block content, addressable by id but not
// independently listed at the top level).
const SUBSTUB_RE = new RegExp(`^#### SUB-STUB:\\s*(${ID_RE_FRAG})\\s*[—–-]\\s*(.*)$`)
const STATUS_RE = /^\*\*Status:\*\*\s*(\S+)(.*)$/
const DEPENDS_RE = /^\*\*Depends on:\*\*\s*(.*)$/
// A stub created by a work item (docs/spec/spec-work-items.md) carries `**Work item:** WI-n`. Claude owns it:
// people read it but cannot change it, so the tracking stays consistent with what the integration run did.
// `**Category:** Name` groups stubs in spec-web's Stubs tab; set by a person or by the categorize-stubs run.
const CATEGORY_RE = /^\*\*Category:\*\*\s*(.+)$/
const WORK_ITEM_RE = /^\*\*Work item:\*\*\s*(WI-\d+)/
// PLAYWORK_ACTOR is set by agent-run.mjs for headless runs ('claude') and by spec-web when a person closes a work item ('system').
const MAY_EDIT_MANAGED = ['claude', 'system'].includes(process.env.PLAYWORK_ACTOR || '')

function parse(lines) {
  const index = new Map() // id -> { line, title, status }
  const blocks = new Map() // id -> { start, end, bodyEnd, title, statusLine, status, statusRest }
  const subblocks = new Map() // id -> { start, end, parentId, title, statusLine, status, statusRest }

  const starts = []
  lines.forEach((ln, i) => {
    if (INDEX_ROW_RE.test(ln)) {
      const { id, title, statusCell } = indexCells(ln)
      // First token only — the rest is explanatory prose that must survive edits.
      const [status, ...rest] = statusCell.split(/\s+/)
      index.set(id, { line: i, title, status, statusRest: rest.length ? ' ' + rest.join(' ') : '' })
    }
    const sm = STUB_RE.exec(ln)
    if (sm) starts.push({ i, id: sm[1], title: sm[2].trim() })
  })

  starts.forEach((s, n) => {
    // A stub runs to the next stub heading (or EOF). Deliberately NOT delimited
    // by `---` or `# ` — several stubs embed a verbatim game spec containing
    // both, and using those as terminators truncates the block.
    const end = n + 1 < starts.length ? starts[n + 1].i - 1 : lines.length - 1
    let statusLine = -1, status = null, statusRest = ''
    for (let i = s.i; i <= Math.min(s.i + 6, end); i++) {
      const m = STATUS_RE.exec(lines[i])
      if (m) { statusLine = i; status = m[1]; statusRest = m[2]; break }
    }
    let depsLine = -1, deps = []
    for (let i = s.i; i <= Math.min(s.i + 8, end); i++) {
      const m = DEPENDS_RE.exec(lines[i])
      if (m) { depsLine = i; deps = m[1].split(/[,\s]+/).filter((x) => new RegExp('^' + ID_RE_FRAG + '$').test(x)); break }
    }
    let workItem = null
    for (let i = s.i; i <= Math.min(s.i + 8, end); i++) {
      const m = WORK_ITEM_RE.exec(lines[i])
      if (m) { workItem = m[1]; break }
    }
    let category = null
    for (let i = s.i; i <= Math.min(s.i + 9, end); i++) {
      const m = CATEGORY_RE.exec(lines[i])
      if (m) { category = m[1].trim(); break }
    }
    blocks.set(s.id, { start: s.i, end, bodyEnd: end, title: s.title, statusLine, status, statusRest, depsLine, deps, workItem, category })
  })

  // Second pass: find every #### SUB-STUB heading nested inside each parent's
  // own span, and shrink the parent's OWN `bodyEnd` to stop right before the
  // first one — otherwise `qa()`/`completionNotes()` on the PARENT would
  // search all the way through every sub-stub's content too (they share one
  // contiguous line range) and could pick up a sub-stub's own Open
  // Questions/Answers as if they belonged to the parent. `end` itself is left
  // untouched (still the true full span) since `cmdReopen` needs it to find
  // where to append the NEXT sub-stub, after any existing ones.
  for (const [parentId, pb] of blocks) {
    const subStarts = []
    for (let i = pb.start; i <= pb.end; i++) {
      const sm = SUBSTUB_RE.exec(lines[i])
      if (sm) subStarts.push({ i, id: sm[1], title: sm[2].trim() })
    }
    if (!subStarts.length) continue
    pb.bodyEnd = subStarts[0].i - 1
    subStarts.forEach((s, n) => {
      const end = n + 1 < subStarts.length ? subStarts[n + 1].i - 1 : pb.end
      let statusLine = -1, status = null, statusRest = ''
      for (let i = s.i; i <= Math.min(s.i + 6, end); i++) {
        const m = STATUS_RE.exec(lines[i])
        if (m) { statusLine = i; status = m[1]; statusRest = m[2]; break }
      }
      subblocks.set(s.id, { start: s.i, end, parentId, title: s.title, statusLine, status, statusRest })
    })
  }

  return { index, blocks, subblocks }
}

/** Questions/answers within a stub block.
 *  Uses the LAST occurrence of each marker inside the block: a couple of stubs
 *  embed a verbatim external spec that can contain similar bold headings, and
 *  the real Q/A blocks are always at the tail of a stub by convention. */
function qa(lines, block) {
  // A top-level block's `bodyEnd` stops before its first nested sub-stub (see
  // `parse()`) — a sub-stub's own block never sets it, so `?? block.end`
  // covers both. Without this, a parent stub's Q/A search would run straight
  // through every reopen's own Open Questions/Answers as if they were its own.
  const upper = block.bodyEnd ?? block.end
  const findLast = (re) => {
    for (let i = upper; i >= block.start; i--) if (re.test(lines[i])) return i
    return -1
  }
  const qStart = findLast(/^\*\*Open Questions:\*\*\s*$/)
  const aStart = findLast(/^\*\*Answers:\*\*\s*$/)

  const collect = (from) => {
    const out = []
    if (from < 0) return out
    for (let i = from + 1; i <= upper; i++) {
      const m = /^>\s*([QA])(\d+):\s*(.*)$/.exec(lines[i])
      if (m) { out.push({ line: i, n: Number(m[2]), text: m[3] }); continue }
      // Blank lines inside a Q/A run are tolerated; anything else ends it.
      if (lines[i].trim() === '') continue
      break
    }
    return out
  }

  const questions = collect(qStart).map((q) => ({
    ...q,
    blocking: /\[BLOCKING\]/i.test(q.text),
  }))
  const answers = collect(aStart)
  const answered = new Set(answers.map((a) => a.n))
  return {
    qStart, aStart, questions, answers,
    unanswered: questions.filter((q) => !answered.has(q.n)),
    unansweredBlocking: questions.filter((q) => !answered.has(q.n) && q.blocking),
  }
}

/**
 * Completion notes — a separate, plain-bullet section distinct from
 * Open Questions/Answers on purpose: those are a design-decision log (a real
 * question, a collaborator's real answer), while a completion note is the
 * implementer's own record of what was actually done and how it was
 * verified. Mixing the two — recording a resolution summary as the "answer"
 * to a manufactured question — buries it under the wrong heading and makes
 * it look like part of the decision log rather than what it is. This section
 * must be visible and readable independently of the Q/A state.
 *
 * Same last-occurrence-backward-search convention as `qa()`, for the same
 * reason (a stub can embed a verbatim external spec with similar headings).
 */
function completionNotes(lines, block) {
  const upper = block.bodyEnd ?? block.end // see the identical note in qa()
  const findLast = (re) => {
    for (let i = upper; i >= block.start; i--) if (re.test(lines[i])) return i
    return -1
  }
  const start = findLast(/^\*\*Completion Notes:\*\*\s*$/)
  const items = []
  if (start >= 0) {
    for (let i = start + 1; i <= upper; i++) {
      const m = /^-\s+(.*)$/.exec(lines[i])
      if (m) { items.push({ line: i, text: m[1] }); continue }
      if (lines[i].trim() === '') continue
      break
    }
  }
  return { start, items }
}

function getBlock(parsed, id) {
  const b = parsed.blocks.get(id) ?? parsed.subblocks.get(id)
  if (!b) die(`no stub block found for ${id}`)
  return b
}

// ── Render ───────────────────────────────────────────────────────────────────
// Shared display helpers used by every command that prints for a human
// (list / show / questions / check / ask / enable's blocking-question dump).
// JSON output paths (--json) bypass all of this deliberately, so a caller
// never has to strip ANSI codes or reverse-engineer the pretty layout.

const WIDTH = Math.max(60, Math.min(process.stdout.columns || 100, 100))

/** Length ignoring ANSI escape codes — needed for anything that pads/wraps
 *  already-coloured text, since the codes themselves have zero visible width. */
function visibleLength(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length
}

function padVisible(s, width) {
  const len = visibleLength(s)
  return len >= width ? s : s + ' '.repeat(width - len)
}

function rule(width = WIDTH, ch = '─') {
  return dim(ch.repeat(width))
}

/** Greedy word-wrap that measures visible (post-ANSI) width. Returns an array
 *  of lines with NO indent applied — callers decide how to prefix each line,
 *  since the first line often follows a colored label/prefix that isn't part
 *  of the wrapped text itself. */
function wrapLines(text, width) {
  const words = String(text).split(/\s+/).filter(Boolean)
  if (!words.length) return ['']
  const lines = []
  let cur = ''
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w
    if (visibleLength(cand) > width && cur) { lines.push(cur); cur = w }
    else cur = cand
  }
  if (cur) lines.push(cur)
  return lines
}

/** Paints inline markdown — `code` and **bold** — for terminal display.
 *  Code spans are painted before bold so a `**bold `code`**` combination
 *  (rare, but present) still colors the code span rather than losing it
 *  inside the outer bold match's `[^*]+` character class. */
function paintInline(s) {
  return String(s)
    .replace(/`([^`]+)`/g, (_, t) => cyan(t))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => bold(t))
}

const STATUS_COLOR = { deferred: yellow, enabled: cyan, 'in-progress': magenta, 'in-qa': blue, done: green }

function statusChip(status) {
  const fn = STATUS_COLOR[status] || ((s) => s)
  return fn(bold(status.toUpperCase()))
}

/** One-line readiness summary for a stub's questions — shared by `list`,
 *  `questions --json`'s pretty sibling, and reused visually (not literally,
 *  since enable's dump is multi-question) by `enable`'s blocking dump. */
function readiness(info) {
  if (info.unansweredBlocking.length) return { icon: red('✗'), label: red(`${info.unansweredBlocking.length} BLOCKING`) }
  if (info.unanswered.length) return { icon: yellow('·'), label: yellow(`${info.unanswered.length} optional`) }
  if (info.questions.length) return { icon: green('✓'), label: green('ready') }
  return { icon: dim('·'), label: dim('no questions') }
}

/** Prints one question (from a `qa()` result) with its BLOCKING/OPTIONAL chip
 *  and word-wrapped body. Shared by `questions`, `ask`, and `enable`'s dump so
 *  a question always looks the same no matter which command surfaced it. */
function printQuestion(q) {
  const tag = q.blocking ? red(bold('[BLOCKING]')) : yellow('[OPTIONAL]')
  const text = q.text.replace(/\[(BLOCKING|OPTIONAL)\]\s*/i, '')
  console.log(`\n  ${bold(cyan('Q' + q.n))} ${tag}`)
  for (const l of wrapLines(paintInline(text), WIDTH - 4)) console.log('    ' + l)
}

function isTableSepRow(cells) {
  return cells.every((cell) => /^:?-{2,}:?$/.test(cell.trim()))
}

/** Renders a run of consecutive `| a | b |` markdown lines as an aligned
 *  terminal table — real ones appear inside several stub bodies (S-1's
 *  license-tier table, several game spec tables, etc.), and printed raw they
 *  are unreadable once the `|` padding no longer lines up in a proportional
 *  terminal font. */
function renderTable(rawLines) {
  const rows = rawLines
    .map((l) => l.trim().replace(/^\|/, '').replace(/\|$/, ''))
    .map((l) => l.split('|').map((cell) => cell.trim()))
    .filter((cells) => !isTableSepRow(cells))
  if (!rows.length) return []

  const ncols = Math.max(...rows.map((r) => r.length))
  const painted = rows.map((r) => Array.from({ length: ncols }, (_, ci) => paintInline(r[ci] ?? '')))
  const widths = Array(ncols).fill(0)
  painted.forEach((r) => r.forEach((cell, ci) => { widths[ci] = Math.max(widths[ci], visibleLength(cell)) }))

  const out = []
  painted.forEach((r, ri) => {
    const line = '  ' + r.map((cell, ci) => padVisible(cell, widths[ci])).join(dim(' │ '))
    out.push(ri === 0 ? bold(line) : line)
    if (ri === 0) out.push('  ' + widths.map((w) => dim('─'.repeat(w))).join(dim('─┼─')))
  })
  return out
}

/**
 * Renders one stub block's raw SPEC_STUBS.md lines as formatted terminal output.
 * Handles: the STUB heading itself, nested markdown headings (several stubs
 * embed a verbatim external game spec with its own # / ## / ### structure),
 * `**Status:**`, generic `**Field:**` labels, the Open Questions/Answers
 * section dividers, pipe tables, `> Qn:`/`> An:` blockquotes, horizontal
 * rules, and bullet lists — everything else falls through to word-wrapped
 * prose with inline `code`/**bold** painted.
 */
function renderStub(lines) {
  const out = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const stubMatch = STUB_RE.exec(line)
    if (stubMatch) {
      out.push(rule())
      out.push(`  ${bold(cyan(stubMatch[1]))}  ${bold(paintInline(stubMatch[2]))}`)
      out.push(rule())
      i++; continue
    }

    const headMatch = /^(#{1,6})\s+(.*)$/.exec(line)
    if (headMatch) {
      out.push('')
      out.push(bold(headMatch[1].length <= 2 ? magenta(headMatch[2]) : headMatch[2]))
      i++; continue
    }

    const statusMatch = STATUS_RE.exec(line)
    if (statusMatch) {
      const [, st, rest] = statusMatch
      out.push(`  ${bold('Status')}   ${statusChip(st)}${rest ? dim(rest) : ''}`)
      out.push('')
      i++; continue
    }

    const fieldMatch = /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(line)
    if (fieldMatch) {
      const [, label, rest] = fieldMatch
      if (/^(Open Questions|Answers|Completion Notes)$/i.test(label)) {
        const bar = '─'.repeat(Math.max(3, Math.floor((WIDTH - label.length - 4) / 2)))
        out.push('')
        out.push(`${dim(bar)} ${bold(magenta(label))} ${dim(bar)}`)
        i++; continue
      }
      out.push('')
      out.push(bold(cyan(label)))
      if (rest.trim()) {
        for (const l of wrapLines(paintInline(rest.trim()), WIDTH - 2)) out.push('  ' + l)
      }
      i++; continue
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const tbl = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { tbl.push(lines[i]); i++ }
      out.push(...renderTable(tbl))
      continue
    }

    const qMatch = /^>\s*Q(\d+):\s*(.*)$/.exec(line)
    if (qMatch) {
      const [, num, rest] = qMatch
      const tagMatch = /^\[(BLOCKING|OPTIONAL)\]\s*(.*)$/.exec(rest)
      const tag = tagMatch ? tagMatch[1] : null
      const text = tagMatch ? tagMatch[2] : rest
      const chip = tag === 'BLOCKING' ? red(bold('[BLOCKING]')) : tag === 'OPTIONAL' ? yellow('[OPTIONAL]') : ''
      out.push('')
      out.push(`  ${bold(cyan('Q' + num))}${chip ? ' ' + chip : ''}`)
      for (const l of wrapLines(paintInline(text), WIDTH - 4)) out.push('    ' + l)
      i++; continue
    }
    const aMatch = /^>\s*A(\d+):\s*(.*)$/.exec(line)
    if (aMatch) {
      const [, num, rest] = aMatch
      const wrapped = wrapLines(paintInline(rest), WIDTH - 7)
      out.push(`  ${bold(green('A' + num))} ${wrapped[0]}`)
      for (let k = 1; k < wrapped.length; k++) out.push('      ' + wrapped[k])
      i++; continue
    }

    if (/^-{3,}\s*$/.test(line)) { out.push(rule()); i++; continue }

    const bulletMatch = /^(\s*)-\s+(.*)$/.exec(line)
    if (bulletMatch) {
      const [, indent, rest] = bulletMatch
      const wrapped = wrapLines(paintInline(rest), Math.max(20, WIDTH - indent.length - 2))
      out.push(`${indent}${dim('•')} ${wrapped[0]}`)
      for (let k = 1; k < wrapped.length; k++) out.push(`${indent}  ${wrapped[k]}`)
      i++; continue
    }

    if (line.trim() === '') { out.push(''); i++; continue }

    for (const l of wrapLines(paintInline(line), WIDTH)) out.push(l)
    i++
  }
  return out.join('\n')
}

// ── Commands ─────────────────────────────────────────────────────────────────
/** Every sub-stub nested under `parentId` (see `cmdReopen`), same shape as a
 *  top-level `list --json` row, in the order they were created (letter
 *  order — 'a' before 'b' — since ids are only ever handed out in that
 *  order). Used by `cmdList`'s `--json` output. */
function subStubsFor(doc, parsed, parentId) {
  return [...parsed.subblocks.entries()]
    .filter(([, sb]) => sb.parentId === parentId)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, sb]) => {
      const info = qa(doc.lines, sb)
      const notes = completionNotes(doc.lines, sb)
      return {
        id, title: sb.title, status: sb.status,
        questions: info.questions.length,
        unanswered: info.unanswered.length,
        unansweredBlocking: info.unansweredBlocking.length,
        readyToEnable: info.unansweredBlocking.length === 0,
        notes: notes.items.length,
      }
    })
}

function cmdList(doc, parsed, [status = 'deferred'], flags = {}) {
  if (status !== 'all' && !STATUSES.includes(status)) {
    die(`unknown status "${status}" (expected: ${STATUSES.join(', ')}, or "all")`)
  }
  const rows = [...parsed.blocks.entries()]
    .filter(([, b]) => status === 'all' || b.status === status)
    .sort((a, b) => idNum(a[0]) - idNum(b[0]))
    .map(([id, b]) => ({ id, b, info: qa(doc.lines, b), notes: completionNotes(doc.lines, b) }))

  // Machine-readable form, so a caller never has to scrape the pretty output.
  // `subStubs` nests every reopen recorded under this stub (see `cmdReopen`)
  // in the exact same shape as a top-level row, minus an index-row-derived
  // field none of them have — spec-web's client renders each one as a
  // further card nested inside the parent's own card via the same
  // `buildStubCard()` it already uses for top-level rows.
  if (flags.json) {
    console.log(JSON.stringify(rows.map(({ id, b, info, notes }) => ({
      id, title: b.title, status: b.status,
      questions: info.questions.length,
      unanswered: info.unanswered.length,
      unansweredBlocking: info.unansweredBlocking.length,
      readyToEnable: info.unansweredBlocking.length === 0,
      notes: notes.items.length,
      dependsOn: b.deps,
      workItem: b.workItem,
      category: b.category,
      subStubs: subStubsFor(doc, parsed, id),
    })), null, 2))
    return
  }

  console.log('')
  console.log(rule())
  console.log(`  ${bold(rows.length + ' stub' + (rows.length === 1 ? '' : 's'))}  ${dim('· status: ' + status)}`)
  console.log(rule())

  if (!rows.length) { console.log(dim('\n  (none)\n')); return }

  const idWidth = Math.max(...rows.map((r) => r.id.length))
  const labelWidth = Math.max(...rows.map((r) => visibleLength(readiness(r.info).label)))

  console.log('')
  for (const { id, b, info } of rows) {
    const { icon, label } = readiness(info)
    const prefix = `  ${cyan(id.padEnd(idWidth))}  ${icon} ${padVisible(label, labelWidth)}  `
    const titleLines = wrapLines(paintInline(b.title), Math.max(20, WIDTH - visibleLength(prefix)))
    console.log(prefix + titleLines[0])
    for (let k = 1; k < titleLines.length; k++) console.log(' '.repeat(visibleLength(prefix)) + titleLines[k])
  }

  const ready = rows.filter((r) => r.info.unansweredBlocking.length === 0).length
  console.log('')
  console.log(rule())
  console.log(`  ${dim('ready to enable:')} ${ready > 0 ? green(`${ready} / ${rows.length}`) : `${ready} / ${rows.length}`}`)
  console.log(rule())
  console.log('')
}

function cmdShow(doc, parsed, [id]) {
  if (!id) die('usage: show <id>')
  const b = getBlock(parsed, id)
  console.log('\n' + renderStub(doc.lines.slice(b.start, b.end + 1)) + '\n')
}

function cmdQuestions(doc, parsed, [id], flags = {}) {
  // Includes reopened sub-stubs, not just top-level blocks.
  const targets = id
    ? [[id, getBlock(parsed, id)]]
    : [...parsed.blocks.entries(), ...parsed.subblocks.entries()]
        .filter(([, b]) => b.status === 'deferred')
        .sort((a, b) => idNum(a[0]) - idNum(b[0]))

  if (flags.json) {
    console.log(JSON.stringify(targets.flatMap(([sid, b]) =>
      qa(doc.lines, b).unanswered.map((q) => ({
        id: sid, n: q.n, blocking: q.blocking,
        text: q.text.replace(/\[(BLOCKING|OPTIONAL)\]\s*/i, ''),
      }))), null, 2))
    return
  }

  let total = 0
  for (const [sid, b] of targets) {
    const { unanswered } = qa(doc.lines, b)
    if (!unanswered.length) continue
    total += unanswered.length
    console.log('')
    console.log(rule())
    console.log(`  ${bold(cyan(sid))}  ${bold(paintInline(b.title))}`)
    console.log(rule())
    for (const q of unanswered) {
      printQuestion(q)
      console.log(dim(`      → npm run spec -- answer ${sid} ${q.n} "..."`))
    }
  }
  console.log(total ? '' : dim('\nno unanswered questions\n'))
}

function cmdAnswer(doc, parsed, args, flags) {
  const [id, nStr, ...rest] = args
  const text = toSingleLine(rest.join(' '))
  if (!id || !nStr || !text) die('usage: answer <id> <n> <text...>')
  const n = Number(nStr)
  if (!Number.isInteger(n)) die(`"${nStr}" is not a question number`)

  const b = getBlock(parsed, id)
  const info = qa(doc.lines, b)
  if (!info.questions.some((q) => q.n === n)) {
    die(`${id} has no Q${n} (has: ${info.questions.map((q) => 'Q' + q.n).join(', ') || 'none'})`)
  }
  const existing = info.answers.find((a) => a.n === n)
  const line = `> A${n}: ${text}`

  if (existing) {
    if (!flags.force) die(`${id} A${n} already answered — re-run with --force to overwrite:\n  ${dim(doc.lines[existing.line])}`)
    doc.lines[existing.line] = line
    console.log(yellow(`↻ overwrote ${id} A${n}`))
  } else if (info.aStart >= 0) {
    // Insert in numeric order within the existing Answers block.
    const after = info.answers.filter((a) => a.n < n).pop()
    const at = after ? after.line + 1 : info.aStart + 1
    doc.lines.splice(at, 0, line)
    console.log(green(`✓ recorded ${id} A${n}`))
  } else {
    if (info.qStart < 0) die(`${id} has no **Open Questions:** block to attach answers to`)
    const lastQ = info.questions[info.questions.length - 1]
    doc.lines.splice(lastQ.line + 1, 0, '', '**Answers:**', line)
    console.log(green(`✓ recorded ${id} A${n} (created Answers block)`))
  }

  console.log(`  ${paintInline(line)}`)
  const after = qa(doc.lines, getBlock(parse(doc.lines), id))
  if (!after.unansweredBlocking.length && after.questions.length) {
    console.log(green(`  ✓ all BLOCKING questions answered — ready: npm run spec -- enable ${id}`))
  }
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/**
 * Mutates the status in both places (block + index row), preserving any
 * trailing prose after the status token (e.g. "done — resolved by S-50's
 * fix") in both — it is decision-log content, not just an enum value.
 *
 * A sub-stub (nested `#### SUB-STUB:`, id like S-183-a) legitimately has NO
 * index row at all — it is never listed at the top level, only nested under
 * its parent (see `parse()`/`cmdReopen`) — so `idx` is optional here, unlike
 * every other id this function is ever called with.
 *
 * `opts.quiet` suppresses the per-line confirmation and `opts.skipSave`
 * skips the save/print-result step — both exist for `enable-ready`, which
 * mutates many stubs in a loop and wants ONE save + ONE summary at the end
 * rather than N of each. Never insert/remove lines here (only replace text
 * in place) — that invariant is what makes looping over a stale `parsed`
 * safe without re-parsing between iterations.
 */
function setStatus(doc, parsed, id, next, flags, opts = {}) {
  const { quiet = false, skipSave = false } = opts
  const b = getBlock(parsed, id)
  const idx = parsed.index.get(id) // undefined for a sub-stub — see above
  if (!idx && parsed.blocks.has(id)) die(`${id} has a stub block but no index-table row — fix the table first`)

  if (b.status === next && (!idx || idx.status === next)) {
    if (!quiet) console.log(dim(`${id} is already ${next}`))
    return
  }

  doc.lines[b.statusLine] = `**Status:** ${next}${b.statusRest}`
  if (idx) {
    const cells = doc.lines[idx.line].split('|')
    cells[cells.length - 2] = ` ${next}${idx.statusRest} `
    doc.lines[idx.line] = cells.join('|')
  }

  if (!quiet) {
    console.log(green(`✓ ${id}: ${b.status} → ${statusChip(next)}`))
    console.log(dim(`  block  line ${b.statusLine + 1}: ${doc.lines[b.statusLine].trim()}`))
    if (idx) console.log(dim(`  index  line ${idx.line + 1}: ${doc.lines[idx.line].trim()}`))
  }
  if (skipSave) return
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/** Guards the documented "never implement a TBD stub" rule — shared by
 *  `enable` and `enable-ready` so a bulk enable can't slip one through. */
function isChangeDescriptionTBD(doc, b) {
  const body = doc.lines.slice(b.start, b.end + 1).join('\n')
  return /\*\*Change description:\*\*\s*TBD/i.test(body)
}

function cmdEnable(doc, parsed, [id], flags) {
  if (!id) die('usage: enable <id>')
  const b = getBlock(parsed, id)
  const { unansweredBlocking } = qa(doc.lines, b)
  if (unansweredBlocking.length && !flags.force) {
    console.log('')
    console.log(rule())
    console.log(`  ${red('✗')} ${bold(id)} has ${unansweredBlocking.length} unanswered BLOCKING question(s)`)
    console.log(rule())
    for (const q of unansweredBlocking) printQuestion(q)
    console.log(dim('\nAnswer them first (`spec answer` or `spec ask`), or re-run with --force.\n'))
    process.exit(1)
  }
  if (isChangeDescriptionTBD(doc, b) && !flags.force) {
    die(`${id}'s Change description is still TBD — it must be filled in before enabling`)
  }
  const waiting = (b.deps ?? []).filter((d) => !SATISFIED.includes(parsed.blocks.get(d)?.status))
  if (waiting.length) console.log(yellow(`note: ${id} depends on ${waiting.join(', ')} which is not done / in-qa yet`))
  setStatus(doc, parsed, id, 'enabled', flags)
}

/**
 * `enable-ready` — enable every deferred stub that has no unanswered
 * BLOCKING question, in one pass. The bulk counterpart to running `enable`
 * once per id after a `spec ask`/`import-answers` session has cleared a
 * whole batch of questions.
 *
 * A stub whose Change description is still TBD is skipped (reported, not
 * silently enabled) unless --force — same guard as the single-stub `enable`.
 */
function cmdEnableReady(doc, parsed, args, flags) {
  const deferred = [...parsed.blocks.entries()].filter(([, b]) => b.status === 'deferred' && (!b.workItem || MAY_EDIT_MANAGED))

  const ready = [], skippedBlocking = [], skippedTBD = []
  for (const [id, b] of deferred) {
    const info = qa(doc.lines, b)
    if (info.unansweredBlocking.length > 0) { skippedBlocking.push(id); continue }
    if (isChangeDescriptionTBD(doc, b) && !flags.force) { skippedTBD.push(id); continue }
    ready.push({ id, b })
  }
  ready.sort((a, b2) => idNum(a.id) - idNum(b2.id))

  console.log('')
  console.log(rule())
  console.log(`  ${bold(deferred.length + ' deferred stub(s)')}`)
  console.log(rule())
  console.log('')

  if (!ready.length) {
    console.log(dim('  none are ready to enable'))
  } else {
    for (const { id, b } of ready) {
      console.log(`  ${green('✓')} ${cyan(id)}  ${paintInline(b.title)}`)
      // skipSave: one save at the end, not one per stub. Safe to reuse the
      // same `parsed` across iterations — setStatus only ever replaces text
      // on existing lines, never splices, so line numbers never shift.
      setStatus(doc, parsed, id, 'enabled', flags, { quiet: true, skipSave: true })
    }
  }

  if (skippedBlocking.length) {
    console.log(dim(`\n  ${skippedBlocking.length} skipped — unanswered BLOCKING question(s): ${skippedBlocking.join(', ')}`))
  }
  if (skippedTBD.length) {
    console.log(dim(`  ${skippedTBD.length} skipped — Change description still TBD (--force to override): ${skippedTBD.join(', ')}`))
  }

  console.log('')
  if (!ready.length) { console.log(dim('nothing to write\n')); return }
  if (save(doc, flags.dryRun)) console.log(green(`✓ SPEC_STUBS.md updated — ${ready.length} stub(s) enabled\n`))
  else console.log(yellow(`--dry-run: ${ready.length} stub(s) NOT written\n`))
}

function cmdCheck(doc, parsed) {
  const problems = []
  for (const [id, b] of parsed.blocks) {
    const idx = parsed.index.get(id)
    if (!idx) { problems.push(`${id}: stub block with no index row`); continue }
    if (idx.status !== b.status) problems.push(`${id}: index says "${idx.status}" but block says "${b.status}"`)
  }
  for (const id of parsed.index.keys()) {
    if (!parsed.blocks.has(id)) problems.push(`${id}: index row with no stub block`)
  }
  for (const [id, b] of parsed.blocks) {
    for (const d of b.deps) if (!parsed.blocks.has(d)) problems.push(`${id}: depends on ${d}, which does not exist`)
    if (dependsClosure(parsed, id).has(id)) problems.push(`${id}: dependency cycle`)
  }

  const counts = {}
  for (const b of parsed.blocks.values()) counts[b.status] = (counts[b.status] || 0) + 1

  const subCounts = {}
  for (const sb of parsed.subblocks.values()) subCounts[sb.status] = (subCounts[sb.status] || 0) + 1

  console.log('')
  console.log(rule())
  console.log(`  ${bold(parsed.blocks.size + ' stubs')}${parsed.subblocks.size ? dim(`  ·  ${parsed.subblocks.size} sub-stub(s) (reopens)`) : ''}`)
  console.log(rule())
  console.log('')
  for (const st of STATUSES) {
    if (!counts[st]) continue
    console.log(`  ${padVisible(statusChip(st), 20)}${counts[st]}${subCounts[st] ? dim(`  (+${subCounts[st]} sub-stub)`) : ''}`)
  }

  console.log('')
  console.log(rule())
  if (problems.length) {
    console.log(`  ${red(`✗ ${problems.length} problem(s)`)}`)
    console.log(rule())
    for (const p of problems) console.log(`  ${red('•')} ${p}`)
    console.log('')
    process.exit(1)
  } else {
    console.log(`  ${green('✓ index and blocks agree')}`)
    console.log(rule())
    console.log('')
  }
}

// ── Session state ────────────────────────────────────────────────────────────
// Independent of the stub registry (and of `doc`/`parsed`) on purpose — see
// STATE_FILE's own comment above. Callers that only want this must never
// need to load or parse SPEC_STUBS.md; the dispatcher below special-cases
// `state` before `load()` runs, same treatment as `help`.

function readState() {
  if (!existsSync(STATE_FILE)) return { state: 'ready', note: null, updatedAt: null }
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { state: 'ready', note: null, updatedAt: null } }
}

function cmdStateGet(flags) {
  const s = readState()
  if (flags.json) { console.log(JSON.stringify(s)); return }
  console.log('')
  console.log(`  ${padVisible(bold('state'), 12)}${s.state === 'wip' ? yellow('● work in progress') : s.state === 'human' ? red('● HUMAN INTERVENTION NEEDED') : green('● ready')}`)
  if (s.note) console.log(`  ${padVisible(bold('note'), 12)}${s.note}`)
  if (s.checklist?.length) {
    console.log(`  ${bold('checklist')}`)
    const mark = { done: green('✓'), active: yellow('◐'), failed: red('✗'), pending: dim('○'), skipped: dim('–') }
    for (const item of s.checklist) console.log(`    ${mark[itemStatus(item)]} ${item.label}${item.reason ? dim(`  (${item.reason})`) : ''}`)
  }
  console.log(`  ${padVisible(bold('updated'), 12)}${s.updatedAt ?? dim('never')}`)
  console.log('')
}

function cmdStateSet(args, flags) {
  const [next, ...noteParts] = args
  if (!SESSION_STATES.includes(next)) die(`usage: state set <${SESSION_STATES.join('|')}> [note...]`)
  const note = noteParts.join(' ') || null
  const prev = readState()
  // wip and human keep the checklist (a run waiting for a person resumes it); ready clears it (see README.md).
  const checklist = next === 'ready' ? null : (prev.checklist ?? null)
  // human: the run ends here and a person resumes it from the banner; workItem says which work item's develop run starts again.
  const entry = { state: next, note, checklist, updatedAt: new Date().toISOString(), ...(next === 'human' && flags.workItem ? { workItem: flags.workItem } : {}) }
  if (flags.dryRun) { console.log(dim(`--dry-run: would write ${STATE_FILE}`)); console.log(entry); return }
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(entry, null, 2) + '\n')
  console.log(green(`✓ session state → ${next}`) + (note ? `  (${note})` : ''))
}

// Items carry a status (pending|active|done|failed|skipped); older state files only had done:boolean.
// skipped = deliberately not needed (--reason= says why); it counts as finished for the "next step" hand-off, never as done work.
const CHECK_STATUSES = ['pending', 'active', 'done', 'failed', 'skipped']
const itemStatus = (i) => i.status ?? (i.done ? 'done' : 'pending')
// percent (0-100) is the live progress of a running step; the site draws it inside the status circle. A step that finishes is 100,
// one that goes back to pending or is skipped has none.
const withStatus = (i, status, reason, percent) => {
  const { reason: _old, percent: oldPct, ...rest } = i
  const pct = status === 'done' ? 100 : status === 'pending' || status === 'skipped' ? null : Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : (oldPct ?? null)
  // reason doubles as the live detail of a running step ("gradle release 293/535 tasks"), so any status may carry one.
  return { ...rest, status, done: status === 'done', ...(reason ? { reason: String(reason).slice(0, 200) } : {}), ...(pct != null ? { percent: pct } : {}) }
}

// Phases can run at the same time (phase-parallel.mjs, the nightly lanes), and every update reads then rewrites the one state file:
// a directory lock keeps two of them from overwriting each other. A lock older than 10 s is a crashed holder's and is taken over.
function lockState() {
  const lock = STATE_FILE + '.lock'
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  const until = Date.now() + 8000
  for (;;) {
    try { mkdirSync(lock); break } catch (e) {
      if (e.code !== 'EEXIST') return
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmSync(lock, { recursive: true, force: true }); continue } } catch { /* released meanwhile */ }
      if (Date.now() > until) return   // give up waiting: a late update beats a stuck one
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40)
    }
  }
  process.on('exit', () => { try { rmSync(lock, { recursive: true, force: true }) } catch { /* already gone */ } })
}
function writeChecklist(prev, checklist, flags) {
  const entry = { ...prev, checklist, updatedAt: new Date().toISOString() }
  if (flags.dryRun) { console.log(dim(`--dry-run: would write ${STATE_FILE}`)); console.log(entry); return false }
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(entry, null, 2) + '\n')
  return true
}

function cmdChecklistInit(args, flags) {
  const raw = args.join(' ')
  const labels = raw.split('|').map((s) => s.trim()).filter(Boolean)
  if (!labels.length) die('usage: state checklist-init "Step one|Step two|Step three"')
  const prev = readState()
  // Step 1 is in progress the moment the list exists.
  const checklist = labels.map((label, i) => withStatus({ label }, i === 0 ? 'active' : 'pending'))
  if (!writeChecklist(prev, checklist, flags)) return
  console.log(green(`✓ checklist set (${labels.length} step${labels.length === 1 ? '' : 's'})`))
  labels.forEach((l, i) => console.log(`  ${dim(`${i + 1}.`)} ${l}`))
}

function cmdChecklistStart(args, flags) {
  const n = Number(args[0])
  const prev = readState()
  if (!Number.isInteger(n) || n < 1 || !prev.checklist || n > prev.checklist.length) {
    die(`usage: state checklist-start <n>  (1..${prev.checklist?.length ?? 0}; run checklist-init first)`)
  }
  const checklist = prev.checklist.map((item, i) => (i === n - 1 ? withStatus(item, 'active') : itemStatus(item) === 'active' ? withStatus(item, 'pending') : item))
  if (writeChecklist(prev, checklist, flags)) console.log(green(`✓ now working on: ${checklist[n - 1].label}`))
}

// checklist-set "<label>" <status>: upsert by label, for sub-steps a script reports itself (nightly-run).
function cmdChecklistSet(args, flags) {
  const status = args[args.length - 1]
  const label = args.slice(0, -1).join(' ').trim()
  if (!label || !CHECK_STATUSES.includes(status)) die(`usage: state checklist-set "<label>" <${CHECK_STATUSES.join('|')}>`)
  const prev = readState()
  const list = prev.checklist ?? []
  const at = list.findIndex((i) => i.label === label)
  let checklist
  if (at >= 0) checklist = list.map((item, i) => (i === at ? withStatus(item, status, flags.reason, flags.percent) : item))
  else {
    // A new sub-step goes right after the last one of its "Prefix:" group, else after the running step, else at the end.
    const prefix = label.includes(':') ? label.split(':')[0] + ':' : null
    let after = prefix ? list.map((i) => i.label.startsWith(prefix)).lastIndexOf(true) : -1
    if (after < 0) after = list.map((i) => itemStatus(i) === 'active').lastIndexOf(true)
    checklist = [...list]
    checklist.splice(after < 0 ? list.length : after + 1, 0, withStatus({ label }, status, flags.reason, flags.percent))
  }
  // A step that ends (done, skipped, failed) must not leave the spinner with nobody: the next pending step takes it.
  if (['done', 'skipped'].includes(status) && !checklist.some((i) => itemStatus(i) === 'active')) {
    const next = checklist.findIndex((i) => itemStatus(i) === 'pending')
    if (next >= 0) checklist = checklist.map((item, i) => (i === next ? withStatus(item, 'active') : item))
  }
  if (writeChecklist(prev, checklist, flags)) console.log(green(`✓ ${label}: ${status}`) + (flags.reason && status === 'skipped' ? `  (${flags.reason})` : ''))
}

function cmdChecklistCheck(args, flags) {
  const n = Number(args[0])
  const prev = readState()
  if (!Number.isInteger(n) || n < 1 || !prev.checklist || n > prev.checklist.length) {
    die(`usage: state checklist-check <n>  (1..${prev.checklist?.length ?? 0}; run checklist-init first)`)
  }
  let checklist = prev.checklist.map((item, i) => (i === n - 1 ? withStatus(item, 'done') : item))
  // Hand the spinner to the next unfinished step unless something else is already running.
  if (!checklist.some((i) => itemStatus(i) === 'active')) {
    const next = checklist.findIndex((i) => itemStatus(i) === 'pending')
    if (next >= 0) checklist = checklist.map((item, i) => (i === next ? withStatus(item, 'active') : item))
  }
  if (!writeChecklist(prev, checklist, flags)) return
  const done = checklist.filter((i) => i.done).length
  console.log(green(`✓ checklist ${done}/${checklist.length} — checked off: ${checklist[n - 1].label}`))
}

// ── Create / update ──────────────────────────────────────────────────────────

/** The leading numeric part of an id, ignoring any reopen-version letter
 *  suffix — S-183 and S-183-a are both "183". Plain `id.slice(2)` breaks on
 *  a suffixed id (`Number("183-a")` is NaN), which used to silently corrupt
 *  every numeric sort/next-id calculation once a reopened stub existed. */
function idNum(id) {
  const m = /^S-(\d+)/.exec(id)
  return m ? Number(m[1]) : NaN
}

/** Highest existing stub number + 1, considering BOTH the index and the blocks
 *  so a half-registered stub can never hand out a colliding id. A reopened
 *  stub's base number still counts even though its own live id now carries a
 *  letter suffix (e.g. S-183-a) — otherwise its number would look "free" and
 *  a later `add`/`new` could hand it back out to something unrelated. */
function nextId(parsed) {
  const nums = [...parsed.blocks.keys(), ...parsed.index.keys()]
    .map(idNum)
    .filter(Number.isFinite)
  return `S-${(nums.length ? Math.max(...nums) : 0) + 1}`
}

function cmdNextId(doc, parsed) { console.log(nextId(parsed)) }

/**
 * Registers one or more stubs given as raw markdown lines (each starting with
 * a `### STUB: <id|S-NEW> — <title>` heading). Shared by `add` (reads a file)
 * and `create-stub` (builds the markdown in-memory from a JSON spec) so both
 * paths share ONE tested insertion routine rather than two that could drift.
 *
 * This exists because registering a stub by hand means appending a block at
 * the bottom of a 4000-line file AND inserting a matching row into a table
 * ~2700 lines above it. Doing that with shell heredocs is how the two drift
 * apart — which `check` then reports. Here it is one atomic operation.
 *
 * Use `S-NEW` as the id in a heading to have one allocated; a batch of S-NEW
 * stubs gets consecutive ids.
 */
function registerStubs(doc, parsed, srcLines, flags) {
  const heads = []
  const headingRe = new RegExp(`^### STUB:\\s*(${ID_RE_FRAG}|S-NEW)\\s*[—–-]\\s*(.*)$`)
  srcLines.forEach((ln, i) => {
    const m = headingRe.exec(ln)
    if (m) heads.push({ i, id: m[1], title: m[2].trim() })
  })
  if (!heads.length) die('no `### STUB: <id> — <title>` headings found')

  // Allocate ids up front so a batch gets consecutive numbers.
  let n = Number(nextId(parsed).slice(2))
  const planned = heads.map((h) => {
    const id = h.id === 'S-NEW' ? `S-${n++}` : h.id
    if (h.id !== 'S-NEW' && (parsed.blocks.has(id) || parsed.index.has(id))) {
      die(`${id} already exists — use S-NEW to allocate a fresh id`)
    }
    return { ...h, id }
  })

  // Index rows go after the LAST existing row so ordering stays monotonic.
  const lastIndexLine = Math.max(...[...parsed.index.values()].map((v) => v.line))
  if (!Number.isFinite(lastIndexLine)) die('could not locate the index table')

  const newRows = []
  const newBlocks = []
  planned.forEach((p, k) => {
    const end = k + 1 < planned.length ? planned[k + 1].i - 1 : srcLines.length - 1
    const body = srcLines.slice(p.i, end + 1)
    body[0] = `### STUB: ${p.id} — ${p.title}`
    const st = body.find((l) => STATUS_RE.test(l))
    const status = st ? STATUS_RE.exec(st)[1] : 'deferred'
    if (!st) body.splice(1, 0, '**Status:** deferred')
    newRows.push(`| ${p.id} | ${p.title} | ${status} |`)
    newBlocks.push(...body)
  })

  console.log('')
  console.log(bold(`registering ${planned.length} stub(s):`))
  for (const p of planned) console.log(`  ${cyan(p.id)}  ${p.title}`)
  console.log('')

  // Append blocks first, then splice rows — splicing rows first would shift
  // every line index below it, including lastIndexLine's own meaning.
  if (newBlocks[newBlocks.length - 1] !== '') newBlocks.push('')
  doc.lines.push(...newBlocks)
  doc.lines.splice(lastIndexLine + 1, 0, ...newRows)

  if (save(doc, flags.dryRun)) {
    const after = parse(load().lines)
    console.log(green(`✓ SPEC_STUBS.md updated — ${after.blocks.size} stubs total`))
  } else console.log(yellow('--dry-run: not written'))

  return planned.map((p) => p.id)
}

function cmdAdd(doc, parsed, [file], flags) {
  if (!file) die('usage: add <file.md>   (stub markdown; use S-NEW for an auto id)')
  const text = readFileSync(resolve(file), 'utf8')
  registerStubs(doc, parsed, text.split(/\r?\n/), flags)
}

/**
 * `new <title> <text...>` — the minimal, no-file-required path to register a
 * stub from raw, unstructured text (this is what the spec-web "+ New Stub"
 * form calls). Only the title and the raw description are real; everything
 * else a fully-analyzed stub normally has — CLAUDE.md section, Files to
 * read, Tests — is left as an explicit `TBD` placeholder so it reads
 * unmistakably as "not yet triaged," the same convention `stubMarkdownFromSpec`
 * already establishes for Change description. This is deliberately the
 * hand-off point to the spec-planning skill's own Analyze mode: a deferred
 * stub with a real (non-TBD) Change description is technically enable-able
 * as-is, but running Analyze first is how it gets a real section/tests/open
 * questions instead of placeholders. Registers via the same registerStubs()
 * path `add`/`create-stub` use (S-NEW auto-id, atomic index+block write).
 */
function cmdNew(doc, parsed, args, flags) {
  const [title, ...rest] = args
  const text = rest.join(' ').trim()
  if (!title || !text) die('usage: new <title> <text...> [--tests=<desired tests>]')
  // --tests=<value> is optional — the raw-text quick-add path otherwise
  // always leaves this TBD, same as section, for the spec-planning skill's
  // Analyze mode to fill in later. Letting the caller (the web UI's "+ New
  // Stub" form in practice) supply a desired-tests value up front avoids an
  // unnecessary extra round trip when the person filing the stub already
  // knows exactly how they want it verified.
  const testsLine = flags.tests ? String(flags.tests).trim() : 'TBD'
  const srcLines = [
    `### STUB: S-NEW — ${title}`,
    '**Status:** deferred',
    '**CLAUDE.md section:** TBD',
    `**Change description:** ${text}`,
    '**Localization keys:** none',
    `**Tests:** ${testsLine}`,
    '',
  ]
  const ids = registerStubs(doc, parsed, srcLines, flags)
  if (ids.length) {
    console.log(dim(`  → run \`spec ask ${ids[0]}\` or use the spec-planning skill's Analyze mode to turn this into a full stub`))
  }
}

// ── create-stub (structured JSON → full stub markdown) ──────────────────────
// A more ergonomic path than `add` for an agent (or a person) that already
// has the stub's content as structured data rather than hand-formatted
// markdown — the JSON shape mirrors the fields every real stub in this file
// already has, so nothing about the resulting markdown differs from one
// written by hand. `stub-template` prints the exact shape expected.

const STUB_JSON_TEMPLATE = {
  id: 'S-NEW',
  title: '<short one-line title — appears in the index table and the heading>',
  status: 'deferred',
  section: '<CLAUDE.md section this stub belongs under, e.g. "Trainer Overlay → Settings Tab">',
  filesToRead: ['src/path/to/file.tsx', 'src/path/to/other.ts'],
  whatToLookFor: '<what to look for when reading those files — the specific symbols/logic/pattern>',
  changeDescription: '<the actual change to make — this is the one field that must never be left as TBD>',
  localizationKeys: 'none',
  tests: '<how this gets verified — tsc + vitest, plus any manual/e2e/device step>',
  manual: '<optional now, required for in-qa: English manual article slug(s) updated, or "none — reason">',
  analytics: '<optional now, required for in-qa: events/ids tracked, or "none — reason">',
  specDocs: '<optional now, required for in-qa: docs/spec file(s) the finished behaviour is written into, or "none — reason">',
  workItem: '<optional WI-n: marks the stub as managed by that work item (Claude only)>',
  questions: [
    { text: '<an open question that needs an answer before this can be enabled>', blocking: true },
  ],
}

/** Builds one stub's raw markdown lines from a JSON spec object. Field
 *  validation lives here rather than in the caller so both a single-object
 *  and an array-of-objects JSON file get identical checking per stub. */
function stubMarkdownFromSpec(spec, index) {
  const where = index === undefined ? '' : ` (item ${index})`
  for (const req of ['title', 'section', 'changeDescription', 'tests']) {
    if (!spec[req] || !String(spec[req]).trim()) die(`create-stub${where}: missing required field "${req}"`)
  }
  const id = spec.id && /^S-(\d+(-[a-z])?|NEW)$/.test(spec.id) ? spec.id : 'S-NEW'
  const status = spec.status && STATUSES.includes(spec.status) ? spec.status : 'deferred'

  const lines = [`### STUB: ${id} — ${String(spec.title).trim()}`]
  lines.push(`**Status:** ${status}`)
  if (spec.workItem) {
    if (!/^WI-\d+$/.test(spec.workItem)) die(`create-stub${where}: workItem must look like WI-12`)
    lines.push(`**Work item:** ${spec.workItem} (managed by Claude, read-only for people)`)
  }
  lines.push(`**CLAUDE.md section:** ${String(spec.section).trim()}`)
  if (Array.isArray(spec.filesToRead) && spec.filesToRead.length) {
    lines.push('**Files to read:**')
    for (const f of spec.filesToRead) lines.push(`- \`${f}\``)
  }
  if (spec.whatToLookFor && String(spec.whatToLookFor).trim()) {
    lines.push(`**What to look for:** ${String(spec.whatToLookFor).trim()}`)
  }
  lines.push(`**Change description:** ${String(spec.changeDescription).trim()}`)
  lines.push(`**Localization keys:** ${spec.localizationKeys ? String(spec.localizationKeys).trim() : 'none'}`)
  lines.push(`**Tests:** ${String(spec.tests).trim()}`)
  if (spec.manual) lines.push(`**Manual:** ${String(spec.manual).trim()}`)
  if (spec.analytics) lines.push(`**Analytics:** ${String(spec.analytics).trim()}`)
  if (spec.specDocs) lines.push(`**Spec:** ${String(spec.specDocs).trim()}`)
  if (Array.isArray(spec.questions) && spec.questions.length) {
    lines.push('')
    lines.push('**Open Questions:**')
    spec.questions.forEach((q, i) => {
      const text = typeof q === 'string' ? q : q.text
      const blocking = typeof q === 'object' && q.blocking
      if (!text || !String(text).trim()) die(`create-stub${where}: question ${i + 1} has no text`)
      lines.push(`> Q${i + 1}: [${blocking ? 'BLOCKING' : 'OPTIONAL'}] ${String(text).trim()}`)
    })
  }
  return lines
}

/**
 * `create-stub <file.json>` — the structured counterpart to `add`. Reads a
 * JSON file holding either one stub-spec object or an array of them, builds
 * each one's markdown via `stubMarkdownFromSpec`, and registers all of them
 * through the exact same `registerStubs` path `add` uses — so the atomicity
 * guarantee (index row + block inserted together, ids allocated up front)
 * is identical, not a second, separately-maintained implementation of it.
 */
function cmdCreateStub(doc, parsed, [file], flags) {
  if (!file) die('usage: create-stub <file.json>   (see `spec stub-template` for the shape)')
  let data
  try {
    data = JSON.parse(readFileSync(resolve(file), 'utf8'))
  } catch (e) {
    die(`could not parse ${file} as JSON: ${e.message}`)
  }
  const specs = Array.isArray(data) ? data : [data]
  if (!specs.length) die(`${file} contains no stub spec(s)`)

  const srcLines = specs.flatMap((spec, i) => {
    const lines = stubMarkdownFromSpec(spec, specs.length > 1 ? i : undefined)
    return [...lines, '']
  })
  registerStubs(doc, parsed, srcLines, flags)
}

/** `stub-template [file]` — prints (or writes) the exact JSON shape
 *  `create-stub` expects, so the fields never have to be guessed or copied
 *  out of this script's source. */
function cmdStubTemplate(doc, parsed, [file], flags) {
  const json = JSON.stringify(STUB_JSON_TEMPLATE, null, 2)
  if (!file) { console.log(json); return }
  if (flags.dryRun) { console.log(yellow(`--dry-run: would write template to ${file}`)); return }
  writeFileSync(resolve(file), json + '\n', 'utf8')
  console.log(green(`✓ wrote template → ${file}`))
}

/** Splices a new `> Qn: [BLOCKING|OPTIONAL] <text>` line into a stub's Open
 *  Questions block (creating the block if it doesn't exist yet). Shared by
 *  `question` and `reopen` so both insert identically — a reopen reason IS a
 *  question in every structural sense (it needs an answer before `enable`
 *  will allow the stub to move again), it just gets there via a different
 *  entry point. Returns the inserted question number. */
function insertQuestion(doc, b, text, blocking) {
  const info = qa(doc.lines, b)
  const n = info.questions.length ? Math.max(...info.questions.map((q) => q.n)) + 1 : 1
  const tag = blocking ? '[BLOCKING] ' : '[OPTIONAL] '
  const line = `> Q${n}: ${tag}${toSingleLine(text)}`

  if (info.qStart >= 0) {
    const lastQ = info.questions[info.questions.length - 1]
    doc.lines.splice((lastQ ? lastQ.line : info.qStart) + 1, 0, line)
  } else {
    // No Open Questions block yet — create one at the end of the stub, after
    // trimming any trailing blank lines so it does not drift away from the body.
    let at = b.bodyEnd ?? b.end
    while (at > b.start && doc.lines[at].trim() === '') at--
    doc.lines.splice(at + 1, 0, '', '**Open Questions:**', line)
  }
  return { n, line }
}

/** `question <id> <text>` — append an open question (analyze step). */
function cmdQuestion(doc, parsed, args, flags) {
  const [id, ...rest] = args
  const text = rest.join(' ').trim()
  if (!id || !text) die('usage: question <id> <text...> [--blocking]')
  const b = getBlock(parsed, id)
  const { n, line } = insertQuestion(doc, b, text, flags.blocking)
  console.log(green(`✓ added ${id} Q${n}`))
  console.log(`  ${paintInline(line)}`)
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/**
 * `note <id> <text>` — append a completion note. Deliberately a SEPARATE
 * mechanism from `question`/`answer`: a completion note is the implementer's
 * own record of what was done and how it was verified, not a design decision
 * — recording it as the "answer" to a manufactured question buries it under
 * the Open Questions/Answers decision log and makes it look like something
 * it isn't. This is the command to use when finishing a stub (pairs with
 * `status <id> in-qa`), never `answer`.
 */
function cmdNote(doc, parsed, args, flags) {
  const [id, ...rest] = args
  const text = toSingleLine(rest.join(' '))
  if (!id || !text) die('usage: note <id> <text...>')
  const b = getBlock(parsed, id)
  const cn = completionNotes(doc.lines, b)
  const line = `- ${text}`

  if (cn.start >= 0) {
    const at = cn.items.length ? cn.items[cn.items.length - 1].line + 1 : cn.start + 1
    doc.lines.splice(at, 0, line)
  } else {
    // No Completion Notes block yet — create one at the end of the stub
    // (after any Open Questions/Answers), trimming trailing blank lines.
    let at = b.bodyEnd ?? b.end
    while (at > b.start && doc.lines[at].trim() === '') at--
    doc.lines.splice(at + 1, 0, '', '**Completion Notes:**', line)
  }
  console.log(green(`✓ added completion note to ${id}`))
  console.log(`  ${paintInline(line)}`)
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

// A stub can only be reopened from a status that implies work was actually
// attempted — `in-progress` (someone was mid-implementation), `in-qa`
// (self-verified but not human-confirmed), or `done` (confirmed, but a real
// issue turned up later). `deferred`/`enabled` are already "not started" or
// "ready to start" — there is nothing to reopen.
const REOPENABLE_FROM = new Set(['in-progress', 'in-qa', 'done'])

/**
 * The next reopen-version id for whichever stub `id` ultimately belongs to
 * (its ROOT parent, stripping any existing `-<letter>` suffix first) —
 * S-183's first reopen is S-183-a; a SECOND reopen is S-183-b, a SIBLING of
 * -a, never S-183-a-a — reopening is always requested against some specific
 * id (the root, or one of its existing sub-stubs), but the new sub-stub it
 * produces always nests directly under the root, one level deep, never
 * nested inside another sub-stub. So this scans every existing sub-stub id
 * already nested under that same root (wherever `id` itself pointed) and
 * picks the next unused letter, rather than just incrementing `id`'s own
 * suffix. Dies past 'z' (26 reopens of one stub) rather than wrapping or
 * colliding — that many reopens on one item is a strong signal it should be
 * split into fresh top-level stubs instead.
 */
function nextReopenId(parsed, id) {
  const m = /^(S-\d+)(?:-[a-z])?$/.exec(id)
  if (!m) die(`"${id}" doesn't look like a stub id this versioning scheme understands`)
  const base = m[1]
  let maxLetter = ''
  for (const other of parsed.subblocks.keys()) {
    const om = new RegExp(`^${base}-([a-z])$`).exec(other)
    if (om && om[1] > maxLetter) maxLetter = om[1]
  }
  const next = maxLetter ? String.fromCharCode(maxLetter.charCodeAt(0) + 1) : 'a'
  if (next > 'z') die(`${base} has already been reopened 26 times — split it into fresh stubs instead of reopening it again`)
  return `${base}-${next}`
}

/**
 * `reopen <id> <reason...>` — appends a new `#### SUB-STUB: S-<num>-<letter>`
 * section NESTED inside the root stub's own block (never a second top-level
 * `### STUB:` entry, and never renaming/touching the original at all — the
 * original keeps its own id, title, status, and full history exactly as it
 * was). The new sub-stub starts at `deferred` with the reason as its own
 * Change description, ready to go through the normal spec-planning lifecycle
 * (analyze → answer → enable → implement → in-qa) independently of its
 * parent. `id` may be the root itself or one of its existing sub-stubs —
 * either way the new one nests directly under the same root (see
 * `nextReopenId`).
 *
 * This is deliberately NOT the "rename the stub, add a blocking question"
 * design an earlier version of this function used — that made a reopen
 * invisible as its own trackable unit of work (just one more question
 * buried inside an otherwise-unchanged stub) and, worse, silently mangled
 * the original when reopened more than once. A sub-stub is a first-class,
 * independently statusable, independently answerable item — `getBlock`,
 * `qa`, `setStatus`, `answer`, `question`, `note`, and a further `reopen`
 * all already work on a sub-stub id exactly as they do on a top-level one
 * (see `getBlock`'s and `setStatus`'s own "no index row" handling) — the
 * only thing a sub-stub never gets is its own index-table row, since it is
 * meant to be browsed nested under its parent (the spec-web UI renders each
 * parent's `subStubs` as further cards nested inside that parent's own
 * card), not listed as a sibling at the top level.
 */
function cmdReopen(doc, parsed, args, flags) {
  const [id, ...rest] = args
  const reason = toSingleLine(rest.join(' '))
  if (!id || !reason) die('usage: reopen <id> <reason...>')
  const b = getBlock(parsed, id)
  if (!REOPENABLE_FROM.has(b.status) && !flags.force) {
    die(`${id} is "${b.status}" — reopen only applies to in-progress/in-qa/done (--force to override)`)
  }
  const rootId = b.parentId ?? id
  const root = getBlock(parsed, rootId)
  const newId = nextReopenId(parsed, rootId)

  const newLines = [
    '',
    `#### SUB-STUB: ${newId} — ${root.title}`,
    '**Status:** deferred',
    `**Change description:** ${reason}`,
    '**Tests:** TBD',
  ]
  // Insert at the true end of the ROOT's span (root.end, not root.bodyEnd —
  // bodyEnd stops before the first existing sub-stub, but a new one must
  // land AFTER every sub-stub already there, not wedged in before them),
  // trimming trailing blank lines first so it doesn't drift from the content
  // above it.
  let at = root.end
  while (at > root.start && doc.lines[at].trim() === '') at--
  doc.lines.splice(at + 1, 0, ...newLines)

  console.log(green(`✓ reopened ${id} — added ${bold(newId)}, nested under ${rootId} (${id} itself is untouched, still "${b.status}")`))
  console.log(`  ${paintInline(newLines[1])}`)
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/** `status <id> <status>` — any transition. `enable` keeps its own guard. */
// Manual and analytics are one inseparable step of finishing any stub: `in-qa` is refused until the stub records both
// (`docs <id> --manual ... --analytics ...`). Only the English manual is ever written by an agent; the nightly run translates it.
const DOCS_MANUAL_RE = /^\*\*Manual:\*\*\s*(.*)$/
const DOCS_ANALYTICS_RE = /^\*\*Analytics:\*\*\s*(.*)$/
// Code without spec text is unfinished: in-qa also needs the finished behaviour written into docs/spec/*.md.
const DOCS_SPEC_RE = /^\*\*Spec:\*\*\s*(.*)$/
const docsLine = (doc, b, re) => {
  for (let i = b.start; i <= (b.bodyEnd ?? b.end); i++) { const m = re.exec(doc.lines[i]); if (m) return { line: i, text: m[1].trim() } }
  return null
}
/** Why a stub's Manual/Analytics record is not acceptable, or null when it is. */
function docsProblem(doc, b) {
  const man = docsLine(doc, b, DOCS_MANUAL_RE), ana = docsLine(doc, b, DOCS_ANALYTICS_RE)
  const none = (t) => /^none\s*[—–-]\s*\S.{9,}/i.test(t)
  const spc = docsLine(doc, b, DOCS_SPEC_RE)
  if (!man || !man.text) return 'no **Manual:** line'
  if (!ana || !ana.text) return 'no **Analytics:** line'
  if (!spc || !spc.text) return 'no **Spec:** line (write the finished behaviour into docs/spec first)'
  if (!none(man.text)) {
    const slugs = man.text.split(/[,\s]+/).filter(Boolean)
    for (const sl of slugs) if (!existsSync(resolve(ROOT, 'docs', 'manual', 'en', sl + '.md'))) return `manual article "${sl}" does not exist in docs/manual/en`
  }
  if (!none(ana.text) && /^(tbd|todo|\?)/i.test(ana.text)) return '**Analytics:** is still a placeholder'
  if (!none(spc.text)) {
    for (const f of spc.text.split(/[,\s]+/).filter(Boolean).map((x) => x.replace(/#.*$/, ''))) {
      if (!/^docs\/spec\/.+\.md$/.test(f) || !existsSync(resolve(ROOT, f))) return `spec file "${f}" is not an existing docs/spec/*.md file`
    }
  }
  return null
}

const cleanCategory = (v) => toSingleLine(v).replace(/^[-–—]$/, '').slice(0, 40)

/** Sets (or, with an empty value, clears) one stub's category line on `doc.lines`; returns true when something changed. */
function setCategoryLine(doc, id, value) {
  const b = parse(doc.lines).blocks.get(id)
  if (!b) return false
  const name = cleanCategory(value)
  let at = -1
  for (let i = b.start; i <= Math.min(b.start + 9, b.end); i++) if (CATEGORY_RE.test(doc.lines[i])) { at = i; break }
  if (at >= 0) {
    if (!name) { doc.lines.splice(at, 1); return true }
    const next = `**Category:** ${name}`
    if (doc.lines[at] === next) return false
    doc.lines[at] = next
    return true
  }
  if (!name) return false
  let after = b.statusLine >= 0 ? b.statusLine : b.start
  for (let i = after + 1; i <= Math.min(b.start + 4, b.end); i++) if (WORK_ITEM_RE.test(doc.lines[i])) after = i
  doc.lines.splice(after + 1, 0, `**Category:** ${name}`)
  return true
}

/** `category <id> <name...>` (empty name clears) */
function cmdCategory(doc, parsed, args, flags) {
  const [id, ...rest] = args
  if (!id) die('usage: category <id> <name...>   (no name clears it)')
  if (!parsed.blocks.has(id)) die(`no top-level stub ${id}`)
  const changed = setCategoryLine(doc, id, rest.join(' '))
  console.log(changed ? green(`✓ ${id} category: ${cleanCategory(rest.join(' ')) || '(cleared)'}`) : dim(`${id}: category unchanged`))
  if (changed && save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
}

/** `category-bulk <file.json>`: {"S-1": "Name", ...} in one atomic write */
function cmdCategoryBulk(doc, parsed, [file], flags) {
  if (!file) die('usage: category-bulk <file.json>   ({ "S-12": "Category name", ... })')
  let map
  try { map = JSON.parse(readFileSync(resolve(file), 'utf8')) } catch (e) { die(`could not parse ${file}: ${e.message}`) }
  let n = 0, skipped = []
  for (const [id, name] of Object.entries(map)) {
    if (!parsed.blocks.has(id)) { skipped.push(id); continue }
    if (setCategoryLine(doc, id, name)) n++
  }
  console.log(green(`✓ ${n} stub(s) categorized`) + (skipped.length ? yellow(`  (unknown ids skipped: ${skipped.join(', ')})`) : ''))
  if (n && save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
}

/** `docs <id> --manual="<slug, slug | none — reason>" --analytics="<events/ids | none — reason>"` */
function cmdDocs(doc, parsed, args, flags) {
  const [id] = args
  if (!id) die('usage: docs <id> --manual="<slug[, slug] | none — reason>" --analytics="<what is tracked | none — reason>" --spec="<docs/spec/x.md[#section][, ...] | none — reason>"')
  const b = getBlock(parsed, id)
  const set = (re, label, value) => {
    if (value == null) return
    const text = `**${label}:** ${toSingleLine(value)}`
    const cur = docsLine(doc, b, re)
    if (cur) doc.lines[cur.line] = text
    else {
      let at = doc.lines.findIndex((l, i) => i >= b.start && i <= (b.bodyEnd ?? b.end) && /^\*\*Tests:\*\*/.test(l))
      if (at < 0) at = b.statusLine >= 0 ? b.statusLine : b.start
      doc.lines.splice(at + 1, 0, text)
      parsed = parse(doc.lines); b.start = parsed.blocks.get(id)?.start ?? b.start; b.bodyEnd = parsed.blocks.get(id)?.bodyEnd ?? b.bodyEnd; b.end = parsed.blocks.get(id)?.end ?? b.end
    }
  }
  set(DOCS_MANUAL_RE, 'Manual', flags.manual)
  set(DOCS_ANALYTICS_RE, 'Analytics', flags.analytics)
  set(DOCS_SPEC_RE, 'Spec', flags.spec)
  const fresh = parse(doc.lines).blocks.get(id) ?? getBlock(parse(doc.lines), id)
  const problem = docsProblem(doc, fresh)
  console.log(problem ? yellow(`recorded, but still incomplete: ${problem}`) : green(`✓ ${id}: manual and analytics recorded`))
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

function cmdStatus(doc, parsed, [id, next], flags) {
  if (!id || !next) die(`usage: status <id> <${STATUSES.join('|')}>`)
  if (!STATUSES.includes(next)) die(`unknown status "${next}" (expected: ${STATUSES.join(', ')})`)
  if (next === 'in-qa' && !/BACKEND/i.test(SPEC) && parsed.blocks.has(id)) {
    const problem = docsProblem(doc, parsed.blocks.get(id))
    if (problem) die(`${id} cannot go to in-qa yet: ${problem}. Manual, analytics and spec are part of finishing every stub: write the finished behaviour into docs/spec/*.md, update the ENGLISH manual (docs/manual/en only; the nightly run translates it) and decide the analytics, then run: docs ${id} --manual="<slug[, slug] | none — reason>" --analytics="<what is tracked | none — reason>" --spec="<docs/spec/x.md[#section][, ...] | none — reason>"`)
  }
  if (next === 'done' && !flags.force) {
    // The promotion rule requires tsc + tests + spec text written up first, none
    // of which this tool can verify — so make it a deliberate act.
    console.log(yellow('note: `done` also requires tsc, vitest, and the spec section written up.'))
    console.log(yellow('      re-run with --force once that is genuinely true.'))
    process.exit(1)
  }
  setStatus(doc, parsed, id, next, flags)
}

/** `ask [id]` — walk unanswered questions one at a time and record answers.
 *  This is the interactive path for working through a sprint with someone. */
async function cmdAsk(doc, parsed, [id], flags) {
  const readline = await import('node:readline/promises')
  if (!process.stdin.isTTY) die('`ask` needs an interactive terminal — use `answer` in scripts')

  const targets = id
    ? [[id, getBlock(parsed, id)]]
    : [...parsed.blocks.entries()]
        .filter(([, b]) => b.status === 'deferred' && (!b.workItem || MAY_EDIT_MANAGED))
        .sort((a, b) => idNum(a[0]) - idNum(b[0]))

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  let recorded = 0
  try {
    for (const [sid] of targets) {
      // Re-parse each round: earlier answers shift line numbers below them.
      const fresh = parse(doc.lines).blocks.get(sid)
      const { unanswered } = qa(doc.lines, fresh)
      if (!unanswered.length) continue

      console.log('')
      console.log(rule())
      console.log(`  ${bold(cyan(sid))}  ${bold(paintInline(fresh.title))}`)
      console.log(rule())

      for (const q of unanswered) {
        printQuestion(q)
        const ans = (await rl.question(dim('\n  answer (blank = skip, "q" = quit) › '))).trim()
        if (ans === 'q') { console.log(dim('\nstopping.')); return finishAsk(doc, flags, recorded) }
        if (!ans) { console.log(dim('  skipped')); continue }
        cmdAnswerInline(doc, sid, q.n, ans)
        recorded++
      }
    }
  } finally { rl.close() }
  finishAsk(doc, flags, recorded)
}

function finishAsk(doc, flags, recorded) {
  if (!recorded) { console.log(dim('\nno answers recorded')); return }
  if (save(doc, flags.dryRun)) console.log(green(`\n✓ ${recorded} answer(s) written to SPEC_STUBS.md`))
  else console.log(yellow(`\n--dry-run: ${recorded} answer(s) NOT written`))
}

/** Shared answer-insertion used by `answer`, `ask`, and `import-answers`
 *  (no save/exit — callers own the save + summary). `quiet` suppresses the
 *  per-line confirmation, since `import-answers` prints one summary line for
 *  a whole batch instead of one per row. */
function cmdAnswerInline(doc, id, n, text, quiet = false) {
  const b = parse(doc.lines).blocks.get(id)
  const info = qa(doc.lines, b)
  const line = `> A${n}: ${toSingleLine(text)}`
  const existing = info.answers.find((a) => a.n === n)
  if (existing) { doc.lines[existing.line] = line; if (!quiet) console.log(green(`  ✓ recorded A${n}`)); return }
  if (info.aStart >= 0) {
    const after = info.answers.filter((a) => a.n < n).pop()
    doc.lines.splice(after ? after.line + 1 : info.aStart + 1, 0, line)
  } else {
    const lastQ = info.questions[info.questions.length - 1]
    doc.lines.splice(lastQ.line + 1, 0, '', '**Answers:**', line)
  }
  if (!quiet) console.log(green(`  ✓ recorded A${n}`))
}

// ── CSV (export-questions / import-answers) ─────────────────────────────────
// A round-trip pair: export the currently-unanswered questions to a CSV a
// non-technical collaborator can fill in (in Excel, Sheets, whatever), then
// import it back to write the "answer" column into SPEC_STUBS.md as real A-lines.
//
// RFC 4180 quoting throughout — CLAUDE.md's own strings.csv learned this
// lesson the hard way (see its own integrity notes): an unquoted comma or a
// bare `"` in a question/answer would otherwise silently corrupt the row.
// Unlike strings.csv's simpler line-based parser, this one has to handle
// genuinely multi-line quoted fields, since a pasted answer can contain
// its own line breaks.

function csvField(v) {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function csvRow(fields) {
  return fields.map(csvField).join(',')
}

/** Minimal RFC 4180 parser: quoted fields, doubled-quote escaping, and
 *  quoted fields that themselves contain embedded newlines. Returns an
 *  array of rows, each an array of raw (unescaped) field strings. */
function parseCSV(text) {
  const rows = []
  let field = '', row = [], inQuotes = false
  const src = text.replace(/^﻿/, '') // strip a UTF-8 BOM if present
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\r') {
      // ignored outside quotes — the matching \n (or EOF) ends the row
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = ''
    } else {
      field += ch
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows
}

const QUESTION_CSV_HEADER = ['stub_id', 'short_description', 'question', 'answer']

/**
 * `export-questions <file.csv> [id]` — write unanswered questions (default:
 * every deferred stub's, or one stub's if an id is given — same scoping as
 * `questions`) to a CSV with an empty "answer" column to fill in.
 *
 * The question column keeps its `Qn: ...` prefix deliberately — that prefix
 * is what `import-answers` parses back out to know which question an answer
 * belongs to, so there is no separate question-number column to keep in sync
 * with it or accidentally re-sort out of alignment.
 */
function cmdExportQuestions(doc, parsed, [file, id], flags) {
  if (!file) die('usage: export-questions <file.csv> [id]')
  const targets = id
    ? [[id, getBlock(parsed, id)]]
    : [...parsed.blocks.entries()]
        .filter(([, b]) => b.status === 'deferred')
        .sort((a, b) => idNum(a[0]) - idNum(b[0]))

  const rows = [QUESTION_CSV_HEADER]
  for (const [sid, b] of targets) {
    for (const q of qa(doc.lines, b).unanswered) {
      rows.push([sid, b.title, `Q${q.n}: ${q.text}`, ''])
    }
  }

  if (rows.length === 1) { console.log(dim('no unanswered questions to export')); return }

  if (flags.dryRun) {
    console.log(yellow(`--dry-run: would write ${rows.length - 1} question(s) to ${file}`))
    return
  }
  // UTF-8 BOM, same convention this repo's own CSV export (S-114,
  // exportSessionsCsv.ts) already uses so Excel opens it with correct encoding.
  const csv = '﻿' + rows.map(csvRow).join('\r\n') + '\r\n'
  writeFileSync(resolve(file), csv, 'utf8')
  console.log(green(`✓ exported ${rows.length - 1} question(s) → ${file}`))
  console.log(dim(`  fill in the "answer" column, then: npm run spec -- import-answers ${file}`))
}

/**
 * `import-answers <file.csv>` — the other half of `export-questions`. Reads
 * back a CSV (`stub_id, short_description, question, answer`), and for every
 * row with a non-blank answer, writes it as that stub's `> An: ...` line —
 * the SAME insertion path `answer`/`ask` use, so an imported answer is
 * indistinguishable from one typed in directly.
 *
 * short_description is read-only context for whoever filled the sheet in —
 * only stub_id and the `Qn:` prefix inside the question column are actually
 * used to place the answer; the description text itself is never written
 * back anywhere.
 */
function cmdImportAnswers(doc, parsed, [file], flags) {
  if (!file) die('usage: import-answers <file.csv>')
  const raw = readFileSync(resolve(file), 'utf8')
  const table = parseCSV(raw).filter((r) => r.some((cell) => cell.trim() !== ''))
  if (!table.length) die('no rows found in CSV')

  const dataRows = table.slice(1) // assume row 0 is the header, whatever its exact casing
  let applied = 0, blank = 0, alreadyAnswered = 0
  const errors = []

  dataRows.forEach((row, idx) => {
    const rowNo = idx + 2 // +1 for the header row, +1 for 1-indexing
    const [stubId, , questionCol, answerRaw] = row
    if (!stubId) { errors.push(`row ${rowNo}: missing stub_id`); return }
    const answer = (answerRaw ?? '').trim()
    if (!answer) { blank++; return }

    const qMatch = /^\s*Q(\d+)\s*:/.exec(questionCol ?? '')
    if (!qMatch) { errors.push(`row ${rowNo} (${stubId}): question column has no "Qn:" prefix — was it edited?`); return }
    const n = Number(qMatch[1])

    if (!parsed.blocks.has(stubId)) { errors.push(`row ${rowNo}: unknown stub ${stubId}`); return }
    if (parsed.blocks.get(stubId).workItem && !MAY_EDIT_MANAGED) { errors.push(`row ${rowNo}: ${stubId} is managed by ${parsed.blocks.get(stubId).workItem} (read-only for people)`); return }
    const info = qa(doc.lines, parse(doc.lines).blocks.get(stubId))
    if (!info.questions.some((q) => q.n === n)) {
      errors.push(`row ${rowNo}: ${stubId} has no Q${n}`); return
    }
    if (info.answers.some((a) => a.n === n) && !flags.force) { alreadyAnswered++; return }

    cmdAnswerInline(doc, stubId, n, answer, /* quiet */ true)
    applied++
  })

  console.log('')
  console.log(rule())
  console.log(`  ${bold(dataRows.length + ' row(s) read from ' + file)}`)
  console.log(rule())
  console.log('')
  console.log(`  ${applied ? green('✓') : dim('·')} ${applied} answer(s) applied`)
  if (blank) console.log(`  ${dim('·')} ${dim(blank + ' row(s) skipped — blank answer')}`)
  if (alreadyAnswered) console.log(`  ${yellow('·')} ${yellow(`${alreadyAnswered} row(s) skipped — already answered (--force to overwrite)`)}`)
  if (errors.length) {
    console.log(`  ${red('✗')} ${red(errors.length + ' error(s):')}`)
    for (const e of errors) console.log(`      ${red('•')} ${e}`)
  }
  console.log('')

  if (!applied) { console.log(dim('nothing to write\n')); return }
  if (save(doc, flags.dryRun)) console.log(green(`✓ SPEC_STUBS.md updated (${applied} answer(s))\n`))
  else console.log(yellow(`--dry-run: ${applied} answer(s) NOT written\n`))
}

// ── Help ─────────────────────────────────────────────────────────────────────
// Deliberately self-contained (no doc/parsed access) so `--help` always works
// even if SPEC_STUBS.md is missing, unreadable, or fails to parse.

const USAGE = {
  list:      { line: 'list [status|all]', flags: '--json', desc: 'List stubs (default: deferred) with question state.',
               detail: [
                 'status is one of: ' + STATUSES.join(', ') + ', or "all".',
                 'Each row shows whether it is ready to enable (no unanswered BLOCKING questions),',
                 'has only optional questions open, or has none at all.',
               ] },
  questions: { line: 'questions [id]', flags: '--json', desc: 'Show unanswered questions (default: across all deferred stubs).' },
  show:      { line: 'show <id>', desc: 'Print a stub block, nicely formatted.' },
  check:     { line: 'check', desc: 'Verify every index-table row and stub block agree on id/status. Exits 1 on any mismatch.' },
  'next-id': { line: 'next-id', desc: 'Print the next free S-NNN id (considers both the index and the blocks).' },
  new:       { line: 'new <title> <text...>', flags: '--dry-run, --tests=<value>', desc: 'Register a stub from raw text — no file needed (this is what the web UI\'s "+ New Stub" form calls).',
               detail: [
                 'The minimal path: only title and the raw description become real content; section is',
                 'left as an explicit TBD placeholder. Tests is also TBD by default, but --tests=<value>',
                 '(a single argv value, no shell quoting needed) fills it in up front when the desired',
                 'verification is already known. Registers a deferred, S-NEW-id stub through the same',
                 'atomic index+block insertion `add`/`create-stub` use. Hand this off to the',
                 'spec-planning skill\'s Analyze mode (or `spec ask <id>`) to turn it into a fully-triaged',
                 'stub with a real section/open questions.',
               ] },
  add:       { line: 'add <file.md>', flags: '--dry-run', desc: 'Register one or more stubs written as stub markdown.',
               detail: [
                 'Use the literal id "S-NEW" in a `### STUB: S-NEW — Title` heading to have a',
                 'fresh id allocated automatically; a batch of S-NEW stubs in one file gets',
                 'consecutive ids. Inserts the index row(s) and appends the block(s) as ONE',
                 'atomic write, so the two halves can never drift out of sync.',
               ] },
  'create-stub': { line: 'create-stub <file.json>', flags: '--dry-run', desc: 'Register stub(s) from structured JSON instead of hand-written markdown.',
               detail: [
                 'The structured counterpart to `add` — reads either one stub-spec object or an',
                 'array of them and builds the exact same markdown a hand-written stub would have,',
                 'through the identical registerStubs() insertion path `add` uses (same atomicity',
                 'guarantee: index row + block inserted together, ids allocated up front). Required',
                 'fields: title, section, changeDescription, tests. Run `spec stub-template` to see',
                 'the exact shape, including optional filesToRead / whatToLookFor / questions.',
               ] },
  'stub-template': { line: 'stub-template [file.json]', flags: '--dry-run', desc: 'Print (or write) the JSON shape `create-stub` expects.',
               detail: [
                 'With no file, prints to stdout. With a file, writes it there instead — a ready',
                 'starting point to copy and fill in rather than reconstructing the field names',
                 'from memory or this script\'s source.',
               ] },
  question:  { line: 'question <id> <text...>', flags: '--blocking --dry-run', desc: 'Append an open question to a stub (the "analyze" step).' },
  answer:    { line: 'answer <id> <n> <text...>', flags: '--force --dry-run', desc: 'Record an answer to question n. Refuses to overwrite an existing answer unless --force.' },
  category:  { line: 'category <id> <name...>', flags: '--dry-run', desc: "Set (or clear, with no name) a stub's category: how spec-web groups the Stubs tab.",
               detail: ['Stored as a `**Category:** Name` line under the status. `category-bulk <file.json>` takes', '{"S-12": "Name", ...} and writes once. Reuse existing names; keep them short (40 characters).'] },
  'category-bulk': { line: 'category-bulk <file.json>', flags: '--dry-run', desc: 'Set many categories at once from {"S-12": "Name"} JSON.' },
  docs:      { line: 'docs <id> --manual="<slugs|none — reason>" --analytics="<tracked|none — reason>" --spec="<docs/spec files|none — reason>"', flags: '--dry-run', desc: 'Record the English manual articles, analytics and spec files a stub touched (required before in-qa).',
               detail: [
                 'Manual, analytics and spec are one inseparable step of finishing any stub. `status <id> in-qa` is',
                 'refused until all three lines exist. --spec takes docs/spec/*.md paths (each must exist; a #section is',
                 'ignored) or "none — <reason>": the finished behaviour must be written into the spec first.',
                 'Manual: --manual takes article slugs from docs/manual/en (comma',
                 'separated, each must exist) or "none — <reason, 10+ chars>". --analytics takes what is',
                 'tracked (event/ids, spec section) or "none — <reason>". Agents write ONLY the English manual;',
                 'the nightly run translates it into every other language.',
               ] },
  note:      { line: 'note <id> <text...>', flags: '--dry-run', desc: 'Append a completion note — a separate section from Open Questions/Answers.',
               detail: [
                 'Use this when finishing a stub, never `answer` — a completion note is the',
                 'implementer\'s own record of what was done and how it was verified, not a design',
                 'decision. It renders in its own "Completion Notes" section, visible independently',
                 'of the Q/A state (an unrelated, blocking-question count does not affect it).',
                 'Pairs with `status <id> in-qa` when the work is finished and self-verified.',
               ] },
  'export-questions': { line: 'export-questions <file.csv> [id]', flags: '--dry-run', desc: 'Write unanswered questions to a CSV with a blank "answer" column.',
               detail: [
                 'Columns: stub_id, short_description, question, answer. With no id, exports every',
                 'deferred stub\'s unanswered questions (same scoping as `questions`). The question',
                 'column keeps its "Qn: ..." prefix — that is what `import-answers` reads back to',
                 'know which question an answer belongs to, so do not remove it while editing.',
               ] },
  'import-answers': { line: 'import-answers <file.csv>', flags: '--force --dry-run', desc: 'Read a CSV back and write its "answer" column into SPEC_STUBS.md as real answers.',
               detail: [
                 'The other half of `export-questions`. A row with a blank answer is skipped. A row',
                 'whose question already has an answer is skipped unless --force. Uses the exact',
                 'same insertion path as `answer`/`ask`, so an imported answer is indistinguishable',
                 'from one typed in directly.',
               ] },
  ask:       { line: 'ask [id]', flags: '--dry-run', desc: 'Interactively walk unanswered questions one at a time (needs a TTY).',
               detail: [
                 'With no id, walks every deferred stub in order. Blank = skip, "q" = quit and',
                 'save whatever was answered so far. This is the command for working through a',
                 'sprint live with someone, rather than scripting `answer` calls one by one.',
               ] },
  enable:    { line: 'enable <id>', flags: '--force', desc: 'deferred → enabled. Refuses if any BLOCKING question is unanswered (bypass with --force).' },
  'enable-ready': { line: 'enable-ready', flags: '--force --dry-run', desc: 'Enable every deferred stub with no unanswered BLOCKING question, in one pass.',
               detail: [
                 'The bulk counterpart to running `enable` once per id after a `spec ask` or',
                 '`import-answers` session has cleared a whole batch of questions. A stub whose',
                 'Change description is still TBD is skipped and reported, not silently enabled,',
                 'unless --force. One save at the end, not one per stub.',
               ] },
  defer:     { line: 'defer <id>', desc: 'Move a stub back to deferred.' },
  reopen:    { line: 'reopen <id> <reason...>', flags: '--force --dry-run', desc: 'Reopen an in-progress/in-qa/done stub for reanalysis, with a reason.',
               detail: [
                 'Moves the stub back to `deferred` and records the reason as a fresh BLOCKING',
                 'open question tagged "Reopened: ...". The stub cannot be enabled again until',
                 'that question is answered — the same gate `enable` already enforces for any',
                 'other blocking question, so no separate "needs reanalysis" flag was needed.',
                 'Refuses on a stub not currently in-progress/in-qa/done unless --force (there is',
                 'nothing to reopen on a stub that was never started).',
               ] },
  status:    { line: 'status <id> <status>', flags: '--force', desc: `Any status transition (${STATUSES.join('|')}). Moving to "done" needs --force, as a reminder that tsc/vitest/the spec write-up still need to genuinely be done first — this tool can't check that for you.` },
}

// ── Dependencies ─────────────────────────────────────────────────────────────
// A stub that really cannot start before another is done records that in its
// own block as `**Depends on:** S-254, S-255`, right under `**Status:**`.
// It is plain registry data like the status line, so it is only ever written
// here. spec-web reads it back through `list --json` (`dependsOn`) and nests
// the dependent stub under the stub it waits on.
const SATISFIED = ['done', 'in-qa']

/** Set (or, with an empty list, remove) the Depends-on line of `id`.
 *  Re-parses first, because inserting or removing a line shifts every offset. */
function writeDeps(doc, id, ids) {
  const b = getBlock(parse(doc.lines), id)
  const text = ids.length ? `**Depends on:** ${ids.join(', ')}` : null
  if (b.depsLine >= 0) {
    if (text) doc.lines[b.depsLine] = text
    else doc.lines.splice(b.depsLine, 1)
  } else if (text) {
    doc.lines.splice(b.statusLine + 1, 0, text)
  }
}

function dependsClosure(parsed, id, seen = new Set()) {
  for (const d of parsed.blocks.get(id)?.deps ?? []) {
    if (!seen.has(d)) { seen.add(d); dependsClosure(parsed, d, seen) }
  }
  return seen
}

function cmdDepends(doc, parsed, args, flags) {
  const [id, ...on] = args
  if (!id || !on.length) die('usage: depends <id> <depends-on-id...>')
  if (!parsed.blocks.has(id)) die(`${id}: no top-level stub with that id (dependencies are between top-level stubs)`)
  const next = new Set(parsed.blocks.get(id).deps)
  for (const d of on) {
    if (!parsed.blocks.has(d)) die(`${d}: no such stub`)
    if (d === id) die(`${id} cannot depend on itself`)
    if (dependsClosure(parsed, d).has(id)) die(`${id} -> ${d} would make a cycle (${d} already depends on ${id}, directly or not)`)
    next.add(d)
  }
  const ids = [...next].sort((a, b) => idNum(a) - idNum(b))
  writeDeps(doc, id, ids)
  console.log(green(`✓ ${id} depends on ${ids.join(', ')}`))
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

function cmdUndepends(doc, parsed, args, flags) {
  const [id, ...off] = args
  if (!id || (!off.length && !flags.all)) die('usage: undepends <id> <depends-on-id...>   (or: undepends <id> --all)')
  const b = parsed.blocks.get(id)
  if (!b) die(`${id}: no top-level stub with that id`)
  const keep = flags.all ? [] : b.deps.filter((d) => !off.includes(d))
  for (const d of off) if (!b.deps.includes(d)) console.log(yellow(`note: ${id} did not depend on ${d}`))
  writeDeps(doc, id, keep)
  console.log(green(`✓ ${id} ${keep.length ? 'now depends on ' + keep.join(', ') : 'has no dependencies'}`))
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/** `deps [id]` — print the dependency tree (roots are stubs others wait on). */
function cmdDeps(doc, parsed, [only], flags) {
  const kids = new Map() // id -> stubs that depend on it
  for (const [id, b] of parsed.blocks) for (const d of b.deps) {
    if (!kids.has(d)) kids.set(d, [])
    kids.get(d).push(id)
  }
  for (const l of kids.values()) l.sort((a, b) => idNum(a) - idNum(b))
  if (flags.json) {
    console.log(JSON.stringify(Object.fromEntries([...parsed.blocks].filter(([, b]) => b.deps.length).map(([id, b]) => [id, b.deps])), null, 2))
    return
  }
  if (only && !parsed.blocks.has(only)) die(`${only}: no such stub`)
  const roots = only
    ? [only]
    : [...kids.keys()].filter((id) => !parsed.blocks.get(id)?.deps.length).sort((a, b) => idNum(a) - idNum(b))
  if (!roots.length) { console.log(dim('\n  (no dependencies recorded)\n')); return }
  const draw = (id, prefix, last, top) => {
    const b = parsed.blocks.get(id)
    const branch = top ? '' : (last ? '└─▶ ' : '├─▶ ')
    console.log(`  ${prefix}${branch}${cyan(id)} ${statusChip(b.status)} ${b.title}`)
    const next = prefix + (top ? '' : (last ? '    ' : '│   '))
    const list = kids.get(id) ?? []
    list.forEach((k, i) => draw(k, next, i === list.length - 1, false))
  }
  console.log('')
  roots.forEach((r) => draw(r, '', true, true))
  console.log('')
}

// ── Edit / remove (human-authorized) ─────────────────────────────────────────
/**
 * Editing or deleting a stub rewrites registry history, so it needs the human
 * driver, not just whoever runs the command. The check is: a real interactive
 * terminal on BOTH stdin and stdout, and the person types the stub id back.
 * Piped input, an agent's non-interactive shell and spec-web's execFile all fail
 * the TTY test, and no flag (not even --force) skips it. --dry-run needs
 * nothing because it writes nothing. A determined agent could fake a pty, so
 * this is a guard rail; a permission rule on `spec.mjs edit|remove` in the
 * Claude Code settings is the hard stop.
 */
async function requireHumanAuth(action, id, flags) {
  if (flags.dryRun) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    die(`${action} ${id} needs the human driver: run this command yourself in an interactive terminal (an agent or script cannot authorize it)`)
  }
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question(yellow(`  ${action} ${id} rewrites the stub registry. Type ${id} to authorize: `))
  rl.close()
  if (answer.trim() !== id) die('not authorized — nothing changed')
}

const EDIT_FIELDS = {
  section: 'CLAUDE.md section',
  priority: 'Priority',
  look: 'What to look for',
  change: 'Change description',
  loc: 'Localization keys',
  tests: 'Tests',
}

/**
 * `edit <id> <field> <text...>` — rewrite one field of a stub block in place.
 * field = title | section | priority | look | change | loc | tests. A field
 * runs from its `**Label:**` line to the next `**Label:**` line (or the end
 * of the stub body); it is replaced by one single-line `**Label:** text`.
 * Status, questions and answers have their own commands and are not editable here.
 */
async function cmdEdit(doc, parsed, args, flags) {
  const [id, field, ...rest] = args
  const text = toSingleLine(rest.join(' '))
  const fields = ['title', ...Object.keys(EDIT_FIELDS)]
  if (!id || !field || !text) die(`usage: edit <id> <${fields.join('|')}> <text...>`)
  if (!fields.includes(field)) die(`unknown field "${field}" (expected: ${fields.join(', ')})`)
  const b = getBlock(parsed, id)
  if (field === 'title' && text.includes('|')) die('a title cannot contain "|" (it would break the index table row)')
  await requireHumanAuth('edit', id, flags)

  if (field === 'title') {
    doc.lines[b.start] = doc.lines[b.start].replace(/^(#+ (?:SUB-)?STUB:\s*\S+\s*[—–-]\s*).*$/, (_, head) => head + text)
    const idx = parsed.index.get(id)
    if (idx) {
      const cells = doc.lines[idx.line].split('|')
      cells.splice(2, cells.length - 4, ` ${text} `)
      doc.lines[idx.line] = cells.join('|')
    }
  } else {
    const label = EDIT_FIELDS[field]
    const end = b.bodyEnd ?? b.end
    const isLabel = (l) => /^\*\*[^*\n]+:\*\*/.test(l)
    let at = -1
    for (let i = b.start; i <= end; i++) if (doc.lines[i].startsWith(`**${label}:**`)) { at = i; break }
    const line = `**${label}:** ${text}`
    if (at >= 0) {
      let stop = at + 1
      while (stop <= end && !isLabel(doc.lines[stop])) stop++
      let last = stop - 1
      while (last > at && doc.lines[last].trim() === '') last--
      doc.lines.splice(at, last - at + 1, line)
    } else {
      let ins = -1
      for (let i = b.start; i <= end; i++) if (doc.lines[i].startsWith('**Open Questions:**')) { ins = i; break }
      if (ins < 0) { ins = end; while (ins > b.start && doc.lines[ins].trim() === '') ins--; ins++ }
      doc.lines.splice(ins, 0, line)
    }
  }
  console.log(green(`✓ ${id}: ${field} updated`))
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

/**
 * `remove <id>` — delete a stub: its block (reopened sub-stubs live inside it
 * and go too) and its index row. Refuses anything past deferred/delay without
 * --force, and always needs the human's authorization. Stubs that depended on
 * it lose that dependency. The id is not reserved: `next-id` can hand it out
 * again if it was the highest.
 */
async function cmdRemove(doc, parsed, [id], flags) {
  if (!id) die('usage: remove <id>')
  const b = getBlock(parsed, id)
  const idx = parsed.index.get(id)
  if (!['deferred', 'delay'].includes(b.status) && !flags.force) {
    die(`${id} is ${b.status} — only deferred/delay stubs are removed without --force (history of finished work is worth keeping)`)
  }
  await requireHumanAuth('remove', id, flags)
  const subs = [...parsed.subblocks.values()].filter((s) => s.parentId === id).length
  const dependents = [...parsed.blocks].filter(([, x]) => x.deps.includes(id)).map(([d]) => d)

  // Block first (it sits below the index row), then the row, so offsets stay valid.
  const from = b.start
  let to = b.end
  while (from > 0 && doc.lines[from - 1].trim() === '' && to + 1 < doc.lines.length && doc.lines[to + 1].trim() === '') to++
  doc.lines.splice(from, to - from + 1)
  if (idx) doc.lines.splice(idx.line, 1)
  for (const d of dependents) {
    const p = parse(doc.lines)
    writeDeps(doc, d, p.blocks.get(d).deps.filter((x) => x !== id))
  }
  console.log(green(`✓ removed ${id} — ${b.title}`))
  if (subs) console.log(dim(`  ${subs} reopened sub-stub(s) removed with it`))
  if (dependents.length) console.log(yellow(`  ${dependents.join(', ')} no longer depend on ${id}`))
  if (save(doc, flags.dryRun)) console.log(dim('  SPEC_STUBS.md updated'))
  else console.log(yellow('  --dry-run: not written'))
}

function printHelp(topic) {
  if (topic && USAGE[topic]) {
    const u = USAGE[topic]
    console.log(`\n${bold('spec ' + u.line)}\n\n  ${u.desc}`)
    if (u.detail) console.log('\n  ' + u.detail.join('\n  '))
    if (u.flags) console.log(`\n  flags: ${u.flags}`)
    console.log()
    return
  }
  if (topic) console.log(yellow(`(no such command "${topic}" — showing general help)\n`))

  console.log(`
${bold('spec')} — SPEC_STUBS.md stub registry CLI

  ${bold('read')}
  ${cyan('list')} [status|all]        list stubs (default: deferred) with question state
  ${cyan('questions')} [id]           show unanswered questions (default: all deferred)
  ${cyan('show')} <id>                print a stub block
  ${cyan('check')}                    verify index table and stub blocks agree
  ${cyan('next-id')}                  next free stub id
  ${cyan('state')} ${cyan('get')}                spec-web session banner state (independent of stubs)
  ${cyan('state')} ${cyan('set')} <wip|ready|human> [note]   set it — spec-web reads this back on every page load (human [--work-item=WI-n]: a person must act; the banner shows the note and a Resume button)
  ${cyan('state')} ${cyan('checklist-init')} "Step one|Step two|..."   live checklist shown under the WIP banner
  ${cyan('state')} ${cyan('checklist-check')} <n>       mark checklist item n (1-indexed) done; the next step becomes the active one
  ${cyan('state')} ${cyan('checklist-start')} <n>       mark item n as the step in progress (spinner in the banner)
  ${cyan('state')} ${cyan('checklist-set')} "label" <pending|active|done|failed|skipped> [--reason="why"] [--percent=N]   add or update a sub-step by label (skipped = not needed; percent shows in its circle)

  ${bold('create / update')}
  ${cyan('new')} <title> <text>       register a raw-text stub, no file needed — hand off to Analyze mode
  ${cyan('add')} <file.md>            register stub(s) from a markdown file (S-NEW = auto id)
  ${cyan('create-stub')} <file.json>   register stub(s) from structured JSON instead of markdown
  ${cyan('stub-template')} [file.json] print (or write) the JSON shape create-stub expects
  ${cyan('question')} <id> <text>     append an open question   [--blocking]
  ${cyan('answer')} <id> <n> <text>   record an answer          [--force to overwrite]
  ${cyan('note')} <id> <text>         append a completion note (separate from Q/A — use on finishing a stub)
  ${cyan('edit')} <id> <field> <text> rewrite title|section|priority|look|change|loc|tests  (human-authorized)
  ${cyan('remove')} <id>              delete a stub; deferred/delay only without --force  (human-authorized)
  ${cyan('depends')} <id> <on...>     mark that <id> cannot start before the stubs it lists are done
  ${cyan('undepends')} <id> <on...>   drop a dependency (or --all)
  ${cyan('deps')} [id]                print the dependency tree
  ${cyan('ask')} [id]                 walk unanswered questions interactively
  ${cyan('export-questions')} <file.csv> [id]   unanswered questions → CSV, blank "answer" column
  ${cyan('import-answers')} <file.csv>          write a filled-in CSV's answers back into SPEC_STUBS.md

  ${bold('status')}
  ${cyan('enable')} <id>              deferred → enabled (refuses if BLOCKING unanswered)
  ${cyan('enable-ready')}              enable every deferred stub with no BLOCKING question left
  ${cyan('defer')} <id>               back to deferred
  ${cyan('reopen')} <id> <reason>     in-progress/in-qa/done → deferred, with a BLOCKING reason recorded
  ${cyan('status')} <id> <status>     any transition (${STATUSES.join('|')})

  flags: --dry-run  --force  --blocking  --json  --all

  ${dim('edit/remove need a person at an interactive terminal typing the stub id; agents cannot run them')}
  ${dim('run `spec help <command>` for detail on any one command, e.g. `spec help add`')}

  e.g.  npm run spec -- list --json
        npm run spec -- ask S-157
        npm run spec -- add /tmp/new-sprint.md
`)
}

// ── Main ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
// --tests=<value> is the one value-carrying flag (everything else here is a
// bare boolean) — used only by `new` (see cmdNew). Passed as a single argv
// array element by callers (server.mjs's execFile never shells out), so the
// value can contain spaces/quotes/anything with no escaping concerns.
const testsFlag = argv.find((a) => a.startsWith('--tests='))
const flags = {
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  blocking: argv.includes('--blocking'),
  json: argv.includes('--json'),
  all: argv.includes('--all'),
  tests: testsFlag ? testsFlag.slice('--tests='.length) : null,
  manual: (argv.find((a) => a.startsWith('--manual=')) ?? '').slice('--manual='.length) || null,
  analytics: (argv.find((a) => a.startsWith('--analytics=')) ?? '').slice('--analytics='.length) || null,
  spec: (argv.find((a) => a.startsWith('--spec=')) ?? '').slice('--spec='.length) || null,
  workItem: (argv.find((a) => a.startsWith('--work-item=')) ?? '').slice('--work-item='.length) || null,
  reason: (argv.find((a) => a.startsWith('--reason=')) ?? '').slice('--reason='.length) || null,
  percent: (() => { const v = (argv.find((a) => a.startsWith('--percent=')) ?? '').slice('--percent='.length); return v === '' ? undefined : Number(v) })(),
}
const args = argv.filter((a) => !a.startsWith('--'))
const cmd = args.shift()

// Handle help before touching SPEC_STUBS.md at all: `spec --help`, `spec -h`,
// `spec help`, and `spec help <command>` / `spec <command> --help` (the last
// two forms are equally natural, so both are honoured).
//
// EXPLICITLY requested help (`--help`/`-h`/`help`) exits 0 — it did what was
// asked. A genuinely bare invocation (no args at all) exits 1, matching the
// usual "missing required command" convention (e.g. git, npm). The two must
// be told apart independently of `cmd`: `--help`/`-h` are stripped out of
// `args` during flag-parsing, so a bare `spec --help` also leaves cmd
// undefined — checking `cmd === undefined` alone conflated the two cases and
// made `--help` alone exit 1 like an error, while `-h` alone correctly exited 0.
const explicitHelp = cmd === 'help' || argv.includes('--help') || argv.includes('-h')
if (explicitHelp || cmd === undefined) {
  const topic = cmd === 'help' ? args[0] : (cmd && cmd !== '--help' && cmd !== '-h' ? cmd : undefined)
  printHelp(topic)
  process.exit(explicitHelp ? 0 : 1)
}

// `state` is fully independent of SPEC_STUBS.md — handled before load() so it
// never touches the stub registry file at all (same treatment as `help`).
if (cmd === 'state') {
  const sub = args[0]
  if (sub !== 'get') lockState()   // every writer takes the lock; readers need none (the file is replaced whole)
  if (sub === 'get') cmdStateGet(flags)
  else if (sub === 'set') cmdStateSet(args.slice(1), flags)
  else if (sub === 'checklist-init') cmdChecklistInit(args.slice(1), flags)
  else if (sub === 'checklist-check') cmdChecklistCheck(args.slice(1), flags)
  else if (sub === 'checklist-start') cmdChecklistStart(args.slice(1), flags)
  else if (sub === 'checklist-set') cmdChecklistSet(args.slice(1), flags)
  else die(`usage: state <get|set|checklist-init|checklist-check|checklist-start|checklist-set> ...`)
  process.exit(0)
}

const doc = load()
const parsed = parse(doc.lines)

// Stubs owned by a work item are read-only for people (docs/spec/spec-work-items.md): only a headless Claude run
// or spec-web closing the work item may change them.
const WRITES_BY_ID = new Set(['docs', 'answer', 'enable', 'defer', 'status', 'question', 'note', 'reopen', 'edit', 'remove', 'depends', 'undepends'])
if (WRITES_BY_ID.has(cmd) && args[0] && !MAY_EDIT_MANAGED) {
  const owner = parsed.blocks.get(args[0]) ?? parsed.blocks.get(parsed.subblocks.get(args[0])?.parentId)
  if (owner?.workItem) die(`${args[0]} is managed by ${owner.workItem} and is read-only for people. Change it through the work item in spec-web.`)
}

switch (cmd) {
  case 'list':      cmdList(doc, parsed, args, flags); break
  case 'show':      cmdShow(doc, parsed, args); break
  case 'questions': cmdQuestions(doc, parsed, args, flags); break
  case 'answer':    cmdAnswer(doc, parsed, args, flags); break
  case 'export-questions': cmdExportQuestions(doc, parsed, args, flags); break
  case 'import-answers':   cmdImportAnswers(doc, parsed, args, flags); break
  case 'ask':       await cmdAsk(doc, parsed, args, flags); break
  case 'add':       cmdAdd(doc, parsed, args, flags); break
  case 'new':       cmdNew(doc, parsed, args, flags); break
  case 'create-stub': cmdCreateStub(doc, parsed, args, flags); break
  case 'stub-template': cmdStubTemplate(doc, parsed, args, flags); break
  case 'question':  cmdQuestion(doc, parsed, args, flags); break
  case 'note':      cmdNote(doc, parsed, args, flags); break
  case 'docs':      cmdDocs(doc, parsed, args, flags); break
  case 'category':  cmdCategory(doc, parsed, args, flags); break
  case 'category-bulk': cmdCategoryBulk(doc, parsed, args, flags); break
  case 'reopen':    cmdReopen(doc, parsed, args, flags); break
  case 'status':    cmdStatus(doc, parsed, args, flags); break
  case 'next-id':   cmdNextId(doc, parsed); break
  case 'enable':    cmdEnable(doc, parsed, args, flags); break
  case 'enable-ready': cmdEnableReady(doc, parsed, args, flags); break
  case 'defer':     if (!args[0]) die('usage: defer <id>'); setStatus(doc, parsed, args[0], 'deferred', flags); break
  case 'edit':      await cmdEdit(doc, parsed, args, flags); break
  case 'remove':    await cmdRemove(doc, parsed, args, flags); break
  case 'depends':   cmdDepends(doc, parsed, args, flags); break
  case 'undepends': cmdUndepends(doc, parsed, args, flags); break
  case 'deps':      cmdDeps(doc, parsed, args, flags); break
  case 'check':     cmdCheck(doc, parsed); break
  default:
    printHelp(cmd)
    process.exit(1)
}
