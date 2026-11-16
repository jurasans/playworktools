// runLimited: runs one command under a wall-clock budget and an idle budget, kills the whole process tree when either trips,
// and never waits on pipes a leftover daemon (Gradle) keeps open. Used by the orchestrator, the workers and phase-run.mjs.
import { spawn, spawnSync } from 'node:child_process'

export function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
  else { try { process.kill(-child.pid, 'SIGTERM') } catch { /* already exited */ } }
}

export const fmtMs = (ms) => (ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`)

// Resolves { code, reason }: reason is set when a budget killed it (code 124), else null.
export function runLimited({ cmd, args = [], cwd, env, timeoutMs = 0, idleMs = 0, onData }) {
  return new Promise((res) => {
    const child = spawn([cmd, ...args].join(' '), { cwd, env: { ...process.env, ...env }, shell: true, detached: process.platform !== 'win32' })
    const start = Date.now()
    let last = start, reason = null, done = false
    const finish = (code) => { if (done) return; done = true; clearInterval(tick); res({ code: reason ? 124 : (code ?? 1), reason }) }
    const kill = (why) => { if (reason) return; reason = why; killTree(child); setTimeout(() => finish(124), 5000) }
    const tick = setInterval(() => {
      if (timeoutMs && Date.now() - start > timeoutMs) kill(`timed out after ${fmtMs(timeoutMs)}`)
      else if (idleMs && Date.now() - last > idleMs) kill(`no output for ${fmtMs(idleMs)}`)
    }, 2000)
    const data = (d) => { last = Date.now(); onData?.(d) }
    child.stdout?.on('data', data)
    child.stderr?.on('data', data)
    // 'exit' + a short flush: a daemon spawned by the command inherits the pipes and would keep 'close' from ever firing.
    child.on('exit', (code) => setTimeout(() => finish(code), 3000))
    child.on('close', finish)
    child.on('error', (e) => { reason = reason || `could not start: ${e.message}`; finish(1) })
  })
}
