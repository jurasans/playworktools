#!/usr/bin/env node
// Runs unit + e2e (never the screenshot suite) as one pass, writing live
// progress to tools/spec-web/documentation/state/test-run.json. See tools/spec-web/README.md
// "Test running (host-runner)" for the full picture.
// Usage: node tools/spec/run-full-suite.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, openSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const STATUS_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state')
const RUN_FILE = resolve(STATUS_DIR, 'test-run.json')
const TEST_STATUS_FILE = resolve(STATUS_DIR, 'test-status.json')
const LOG_FILE = resolve(STATUS_DIR, 'test-run.log')
const RECORD_SCRIPT = resolve(ROOT, 'tools', 'spec', 'record-test-run.mjs')

const SUITES = [
  { key: 'unit', label: 'Unit tests (vitest)' },
  { key: 'e2e', label: 'E2E tests (playwright)' },
]

mkdirSync(STATUS_DIR, { recursive: true })

function writeRun(state) {
  writeFileSync(RUN_FILE, JSON.stringify(state, null, 2) + '\n')
}
function readRun() {
  try { return JSON.parse(readFileSync(RUN_FILE, 'utf8')) } catch { return null }
}
function readTestStatus() {
  try { return JSON.parse(readFileSync(TEST_STATUS_FILE, 'utf8')) } catch { return {} }
}
function durationSeconds(startIso, endIso) {
  if (!startIso || !endIso) return null
  return Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000)
}

const prevRun = readRun()
const lastCompletedRun = prevRun && !prevRun.running
  ? { startedAt: prevRun.startedAt, finishedAt: prevRun.finishedAt, totalSeconds: durationSeconds(prevRun.startedAt, prevRun.finishedAt) }
  : (prevRun?.lastCompletedRun ?? null)

const startedAt = new Date().toISOString()
const completed = []

function runSuite(suiteKey) {
  return new Promise((resolvePromise) => {
    const logFd = openSync(LOG_FILE, 'a')
    const child = spawn(process.execPath, [RECORD_SCRIPT, suiteKey], { cwd: ROOT, stdio: ['ignore', logFd, logFd] })
    child.on('close', (code) => resolvePromise(code))
    child.on('error', () => resolvePromise(1))
  })
}

async function main() {
  writeFileSync(LOG_FILE, `\n[run-full-suite] started ${startedAt}\n`)
  for (const suite of SUITES) {
    writeRun({
      running: true,
      phase: suite.key,
      phaseLabel: suite.label,
      startedAt,
      phaseStartedAt: new Date().toISOString(),
      completed,
      lastCompletedRun,
      error: null,
    })
    const code = await runSuite(suite.key)
    const status = readTestStatus()
    completed.push({
      suite: suite.key,
      label: suite.label,
      status: status[suite.key]?.status ?? (code === 0 ? 'pass' : 'fail'),
      summary: status[suite.key]?.summary ?? null,
    })
  }
  const finishedAt = new Date().toISOString()
  writeRun({
    running: false,
    phase: null,
    phaseLabel: null,
    startedAt,
    phaseStartedAt: null,
    finishedAt,
    totalSeconds: durationSeconds(startedAt, finishedAt),
    completed,
    lastCompletedRun,
    error: null,
  })
}

main().catch((err) => {
  const finishedAt = new Date().toISOString()
  writeRun({
    running: false,
    phase: null,
    phaseLabel: null,
    startedAt,
    phaseStartedAt: null,
    finishedAt,
    totalSeconds: durationSeconds(startedAt, finishedAt),
    completed,
    lastCompletedRun,
    error: String(err?.message || err),
  })
  process.exitCode = 1
})
