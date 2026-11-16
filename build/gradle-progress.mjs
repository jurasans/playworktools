#!/usr/bin/env node
// Pipe a gradle run through this: `gradlew assembleRelease 2>&1 | node gradle-progress.mjs release 52 98`.
// Passes the output through, turns the "> Task" lines into "[progress] N% gradle X/Y tasks" (own 0-100 scale, between
// <from> and <to>), and exits non-zero unless Gradle said BUILD SUCCESSFUL (a pipe hides gradle's own exit code on cmd).
// The expected task total is what the last successful build of that type counted, kept in .gradle-task-totals.json.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { progress } from './progress.mjs'

const [type = 'debug', from = '50', to = '98'] = process.argv.slice(2)
const FILE = resolve(dirname(fileURLToPath(import.meta.url)), '.gradle-task-totals.json')
const SEED = { debug: 880, release: 1100 }
let totals = {}
try { totals = JSON.parse(readFileSync(FILE, 'utf8')) } catch { /* first run */ }
const total = totals[type] || SEED[type] || 1000

let count = 0, last = -1, ok = false, buf = ''
function onLine(line) {
  if (/^> Task /.test(line)) {
    count++
    const pct = Math.round(Number(from) + (Math.min(count / total, 0.99)) * (Number(to) - Number(from)))
    if (pct !== last) { last = pct; progress(pct, `gradle ${type} ${count}/${total} tasks`) }
  }
  if (/BUILD SUCCESSFUL/.test(line)) ok = true
}

process.stdin.on('data', (d) => {
  process.stdout.write(d)
  buf += d.toString()
  const lines = buf.split(/\r?\n/); buf = lines.pop()
  lines.forEach(onLine)
})
process.stdin.on('end', () => {
  if (buf) onLine(buf)
  if (ok && count > 50) { totals[type] = count; try { writeFileSync(FILE, JSON.stringify(totals)) } catch { /* best effort */ } }
  process.exit(ok ? 0 : 1)
})
