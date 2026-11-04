#!/usr/bin/env node
/**
 * record-test-run.mjs — runs the unit or e2e suite and records a small
 * pass/fail summary (+ timestamp) that the spec-web tool's Tests tab reads
 * back via `GET /api/test-status`.
 *
 * This is a thin wrapper, not a replacement for `npm run test` / `npm run
 * test:e2e` — it runs the exact same underlying command, just with its
 * stdout/stderr passed through live (so it's still usable interactively)
 * while also buffering the tail of the output to parse a summary line out
 * of it. The wrapper's own exit code matches the underlying command's, with
 * one deliberate exception (S-193-a): for the `e2e` suite, if EVERY failed
 * title comes from the two chronically-flaky quarantined files (see
 * `E2E_QUARANTINED_FILES` below — CLAUDE.md's own documented desktop-
 * resource-contention flakiness class, S-193/S-193-a), the wrapper exits 0
 * and records `status: 'pass'` even though Playwright itself exited non-zero
 * — quarantined per the user's own explicit answer ("i want them quarantied.
 * but i also want them solved"), not silently hidden: the real failure/flaky
 * titles and counts are still recorded under `quarantined` in the status
 * object for visibility. A failure in ANY non-quarantined file still fails
 * the gate exactly as before.
 *
 * Usage:
 *   node tools/spec/record-test-run.mjs unit
 *   node tools/spec/record-test-run.mjs e2e
 *   node tools/spec/record-test-run.mjs e2e -- e2e/some.spec.ts   (extra args
 *     forwarded verbatim to the underlying playwright/vitest invocation)
 *
 * Status file: tools/spec-web/documentation/state/test-status.json (gitignored) — one
 * entry per suite, keyed "unit"/"e2e", never clobbering the other suite's
 * last-known result.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATUS_DIR  = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state')
const STATUS_FILE = resolve(STATUS_DIR, 'test-status.json')

const [, , suiteArg, ...rest] = process.argv
const extra = rest[0] === '--' ? rest.slice(1) : rest

// Playwright's own JSON reporter — "standard tooling" rather than scraping
// stdout a second time — gives real per-test rows (title/file/status/
// duration) that /api/tests/details reads back for the Tests page's
// row-by-row test detail view. Run ALONGSIDE the list reporter (not instead
// of it) so parseE2e()'s stdout-based summary parsing below is unaffected;
// PLAYWRIGHT_JSON_OUTPUT_NAME routes the JSON reporter to a file instead of
// stdout, so the two reporters' output never mixes on the console either.
const E2E_JSON_OUT = resolve(STATUS_DIR, 'e2e-results.json')
const SCREENSHOTS_JSON_OUT = resolve(STATUS_DIR, 'screenshots-results.json')
// Same idea for the unit suite — vitest's own JSON reporter (Jest-compatible
// shape), run ALONGSIDE the default reporter (not instead of it) via two
// --reporter flags + cac's dot-notation --outputFile.json=<path>, so the
// JSON file doesn't disturb parseUnit()'s existing stdout scraping below and
// the console output looks exactly as it always has. Read by server.mjs's
// unitDetails() for the Tests tab's per-file "green dots" square.
const UNIT_JSON_OUT = resolve(STATUS_DIR, 'unit-results.json')

// S-193-a: the two spec files playwright.config.ts's `chromium-serial`
// project already isolates for the documented desktop-resource-contention
// flakiness class (CLAUDE.md's "E2E suite: mock-sensor connect fix +
// environment-flakiness notes", items 4-8) — kept as their own file-name
// list here (not read from the Playwright config) so quarantine logic never
// silently drifts if that project's testMatch ever changes without this
// file being updated too; the two lists SHOULD stay in lockstep by hand.
const E2E_QUARANTINED_FILES = ['calibration-diagram.spec.ts', 'multi-ball.spec.ts']

const SUITES = {
  unit: {
    cmd: 'npx',
    args: ['vitest', 'run', '--reporter=default', '--reporter=json', `--outputFile.json=${UNIT_JSON_OUT}`, ...extra],
    label: 'npx vitest run',
  },
  e2e:  {
    cmd: 'npx', args: ['playwright', 'test', '--reporter=list,json', ...extra],
    label: 'npx playwright test', env: { PLAYWRIGHT_JSON_OUTPUT_NAME: E2E_JSON_OUT },
  },
  // Non-assertive artifact-generation pass (CLAUDE.md's "Device-Matrix
  // Screenshot Suite") — no pass/fail summary line to parse, so this just
  // records exit code + duration; the actual payload is the refreshed
  // e2e-artifacts/ files themselves, browsed via /api/screenshots. Still
  // gets the JSON reporter so the Tests page can list which device/
  // orientation combos ran and how long each took.
  screenshots: {
    cmd: 'npx', args: ['playwright', 'test', '--config=playwright.screenshots.config.ts', '--reporter=list,json', ...extra],
    label: 'npx playwright test --config=playwright.screenshots.config.ts', env: { PLAYWRIGHT_JSON_OUTPUT_NAME: SCREENSHOTS_JSON_OUT },
  },
}

const suite = SUITES[suiteArg]
if (!suite) {
  console.error(`Usage: node tools/spec/record-test-run.mjs <unit|e2e|screenshots> [-- extra args]`)
  process.exit(2)
}

function readStatus() {
  if (!existsSync(STATUS_FILE)) return {}
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf8')) } catch { return {} }
}
function writeStatus(all) {
  mkdirSync(STATUS_DIR, { recursive: true })
  writeFileSync(STATUS_FILE, JSON.stringify(all, null, 2) + '\n')
}

// ── parsing ──────────────────────────────────────────────────────────────────
// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

function parseUnit(text) {
  const t = stripAnsi(text)
  // " Test Files  29 passed (29)" / " Test Files  2 failed | 27 passed (29)"
  const filesM = t.match(/Test Files\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/)
  // "      Tests  267 passed (267)" / "  3 failed | 264 passed (267)"
  const testsM = t.match(/\bTests\s+(?:(\d+) failed \| )?(\d+) passed \((\d+)\)/)
  const durM   = t.match(/Duration\s+([\d.]+m?s)/)
  if (!testsM) return null
  const failed = Number(testsM[1] || 0)
  const passed = Number(testsM[2])
  const total  = Number(testsM[3])
  return {
    passed, failed, total,
    testFiles: filesM ? { failed: Number(filesM[1] || 0), passed: Number(filesM[2]), total: Number(filesM[3]) } : null,
    duration: durM ? durM[1] : null,
    summary: `${passed} passed${failed ? `, ${failed} failed` : ''} (${total})`,
  }
}

function parseE2e(text) {
  const t = stripAnsi(text)
  // Playwright's list-reporter summary is made of UP TO FOUR section headers,
  // each optionally followed by its own indented "[chromium] › ..." title
  // list, in this order when present: "N failed", "N flaky", "N skipped",
  // "N passed (duration)" (always last, always carries the duration). e.g.:
  //   all green:        "  13 passed (45.2s)"
  //   some genuinely red: "  2 failed\n    [chromium] › ...\n    [chromium] › ...\n  74 passed (6.2m)"
  //   some flaky-but-passed: "  2 failed\n    ...\n  9 flaky\n    ...\n  65 passed (12.2m)"
  //
  // A prior version of this parser only looked for the boundary "N failed
  // ... up to N passed", which on a run with any flaky tests silently
  // swallowed the ENTIRE flaky section's titles into failedTitles too —
  // reporting e.g. "2 failed" in the summary while failedTitles listed 11
  // titles (2 real failures + 9 tests that failed once then passed on
  // retry). Found by comparing this file's own parsed output against the
  // raw Playwright log for the same run. Fixed by locating every section
  // header explicitly and bounding each title list at the START of the
  // NEXT header (of any kind), not just at "passed".
  const lines = t.split('\n')
  const headerRe = /^\s*(\d+)\s+(failed|flaky|skipped|passed)\b(?:[^(]*\(([\d.]+(?:ms|m|s))\))?/
  const headers = []
  lines.forEach((line, i) => {
    const m = headerRe.exec(line)
    if (m) headers.push({ i, count: Number(m[1]), kind: m[2], duration: m[3] })
  })
  const passedHeader = [...headers].reverse().find((h) => h.kind === 'passed')
  if (!passedHeader) return null

  const titlesFor = (kind) => {
    const h = headers.find((x) => x.kind === kind)
    if (!h) return []
    const nextI = headers.find((x) => x.i > h.i)?.i ?? lines.length
    return lines.slice(h.i + 1, nextI)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('['))
      // S-193: strip whichever project name prefixes the title, not just a
      // hardcoded "[chromium]" — playwright.config.ts now runs a second
      // `chromium-serial` project (the two chronically flaky specs, run
      // after the main batch finishes to dodge desktop resource contention
      // from the rest of the suite running concurrently), whose titles come
      // through the list reporter as "[chromium-serial] › ...".
      .map((l) => l.replace(/^\[[\w-]+\]\s*›\s*/, ''))
  }

  const passed  = passedHeader.count
  const failed  = headers.find((h) => h.kind === 'failed')?.count ?? 0
  const flaky   = headers.find((h) => h.kind === 'flaky')?.count ?? 0
  const skipped = headers.find((h) => h.kind === 'skipped')?.count ?? 0
  const duration = passedHeader.duration
  const failedTitles = titlesFor('failed')
  const flakyTitles  = titlesFor('flaky')

  const total = passed + failed + skipped
  return {
    passed, failed, flaky, skipped, total,
    duration,
    failedTitles: failedTitles.length ? failedTitles : undefined,
    flakyTitles: flakyTitles.length ? flakyTitles : undefined,
    summary: `${passed} passed${failed ? `, ${failed} failed` : ''}${flaky ? `, ${flaky} flaky` : ''} (${duration})`,
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
mkdirSync(STATUS_DIR, { recursive: true }) // JSON reporter needs its target dir to exist up front
console.log(`\n[record-test-run] ${suite.label}\n`)

// Node warns (DEP0190) about passing an argv array alongside shell:true,
// since shell:true only ever really runs a single joined string — build that
// string explicitly instead. Every argument here is developer-supplied (this
// is a local CLI script, never fed untrusted input), so a plain join is fine.
const fullCommand = [suite.cmd, ...suite.args].join(' ')
const child = spawn(fullCommand, { cwd: ROOT, shell: true, env: { ...process.env, ...(suite.env ?? {}) } })
let buf = ''
child.stdout.on('data', (d) => { process.stdout.write(d); buf += d.toString() })
child.stderr.on('data', (d) => { process.stderr.write(d); buf += d.toString() })

child.on('close', (code) => {
  const parsed = suiteArg === 'unit' ? parseUnit(buf) : parseE2e(buf)

  // S-193-a: quarantine the two chronic flake specs from the pass/fail gate
  // — but only when EVERY failed title belongs to one of them; a single
  // non-quarantined failure still fails the gate exactly as before. `flaky`
  // titles (failed once, passed on retry) never affected the exit code to
  // begin with, so there's nothing to quarantine there.
  let finalCode = code
  let quarantined
  if (suiteArg === 'e2e' && code !== 0 && parsed?.failedTitles?.length) {
    const isQuarantined = (title) => E2E_QUARANTINED_FILES.some((f) => title.includes(f))
    if (parsed.failedTitles.every(isQuarantined)) {
      quarantined = { count: parsed.failedTitles.length, titles: parsed.failedTitles }
      finalCode = 0
    }
  }

  const all = readStatus()
  all[suiteArg] = {
    status: finalCode === 0 ? 'pass' : 'fail',
    exitCode: code,
    timestamp: new Date().toISOString(),
    command: suite.label,
    ...(parsed ?? { summary: finalCode === 0 ? '(exit 0, summary unparsed)' : '(exit non-zero, summary unparsed)' }),
    ...(quarantined ? { quarantined, summary: `${parsed.summary} — ${quarantined.count} quarantined (S-193-a)` } : {}),
  }
  writeStatus(all)
  console.log(`\n[record-test-run] recorded ${suiteArg} → ${all[suiteArg].status} (${all[suiteArg].summary})`)
  if (quarantined) console.log(`[record-test-run] ${quarantined.count} failure(s) quarantined per S-193-a (still visible under "quarantined", did not fail the gate): ${quarantined.titles.join(' | ')}`)
  console.log(`[record-test-run] status file: ${STATUS_FILE}\n`)
  process.exit(finalCode)
})
