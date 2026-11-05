// Talks to ONE long-running pwmanage worker (python -m pwmanage.server) so requests reuse its database connection.
// JSON lines in and out, never argv. The worker is started on the first request and killed (closing the connection)
// when nothing is unlocked any more, or after IDLE_MS without a request.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const MANAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TIMEOUT_MS = 120_000
const IDLE_MS = 16 * 60 * 1000
const MAX_LINE = 8 * 1024 * 1024

function pythonPath() {
  if (process.env.MANAGE_PYTHON) return process.env.MANAGE_PYTHON
  const venv = process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python']
  const local = resolve(MANAGE_DIR, ...venv)
  return existsSync(local) ? local : 'python'
}

let worker = null
let pending = new Map()
let nextId = 1
let idleTimer = null

const failure = (error) => ({ ok: false, kind: 'failed', error })

function stopWorker(reason) {
  clearTimeout(idleTimer)
  const w = worker
  worker = null
  if (w) { try { w.stdin.end() } catch { /* already gone */ } setTimeout(() => w.kill(), 2000).unref() }
  const waiting = pending
  pending = new Map()
  for (const { done, timer } of waiting.values()) { clearTimeout(timer); done(failure(reason)) }
}

function startWorker() {
  const child = spawn(pythonPath(), ['-m', 'pwmanage.server'], { cwd: MANAGE_DIR, env: { ...process.env, PYTHONPATH: MANAGE_DIR, PYTHONUNBUFFERED: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = ''
  let err = ''
  child.stdout.on('data', (d) => {
    buf += d
    if (buf.length > MAX_LINE) return stopWorker('the manage worker sent too much data')
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      try {
        const { id, ...answer } = JSON.parse(line)
        const p = pending.get(id)
        if (p) { clearTimeout(p.timer); pending.delete(id); p.done(answer) }
      } catch { /* not a protocol line */ }
    }
  })
  child.stderr.on('data', (d) => { if (err.length < 4096) err += d })
  child.on('error', (e) => { if (worker === child) stopWorker(`could not start python: ${e.message}`) })
  child.on('exit', () => { if (worker === child) stopWorker(`the manage worker stopped${err ? `: ${err.trim().slice(-300)}` : ''}`) })
  return child
}

export function runManage(request) {
  return new Promise((done) => {
    try { worker ||= startWorker() } catch (e) { return done(failure(`could not start python: ${e.message}`)) }
    const id = nextId++
    const timer = setTimeout(() => stopWorker('the manage worker timed out'), TIMEOUT_MS)
    pending.set(id, { done, timer })
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stopWorker('idle'), IDLE_MS)
    idleTimer.unref()
    worker.stdin.write(JSON.stringify({ id, ...request }) + '\n')
  })
}

/** Close the connections of every environment not in `envs`; with none left, the worker itself is stopped. */
export async function keepManage(envs) {
  if (!worker) return
  if (!envs.length) return stopWorker('locked')
  await runManage({ op: 'keep', envs })
}

export const workerRunning = () => !!worker
