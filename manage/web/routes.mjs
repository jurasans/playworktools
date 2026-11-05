// /manage page and /api/manage/* for spec-web. The caller has already checked the admin role; this adds the
// second password, a preview-before-apply token and the op allow-list. Data work happens in the python scripts.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runManage, keepManage } from './run-python.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const IDLE_MS = 15 * 60 * 1000
const MAX_TRIES = 5
const LOCKOUT_MS = 15 * 60 * 1000
const MAX_BODY = 128 * 1024
const ENVS = ['stage', 'prod']
const READ_OPS = new Set(['search_sensors', 'list_licenses', 'search_customers', 'customer_schema'])
const FIELDS = ['query', 'field', 'limit', 'offset']

const same = (a, b) => {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createManage({ password = process.env.MANAGE_PASSWORD, run = defaultRunner, release: releaseFn = defaultRelease, now = () => Date.now() } = {}) {
  const secret = randomBytes(32)
  const unlocked = new Map() // session key -> { env, until }
  let fails = 0
  let lockedUntil = 0

  // The worker keeps one database connection per unlocked environment; anything no longer unlocked is closed.
  const liveEnvs = () => [...new Set([...unlocked.values()].map((u) => u.env))]
  const release = async () => { try { await releaseFn(liveEnvs()) } catch { /* the worker's own idle timer is the backstop */ } }
  const reap = () => { let n = 0; for (const [k, u] of unlocked) if (u.until <= now()) { unlocked.delete(k); n++ } return n }
  const sweep = async () => { if (reap()) await release() }
  setInterval(sweep, 30_000).unref()

  const token = (key, env, actions) => createHmac('sha256', secret).update(JSON.stringify([key, env, actions])).digest('hex')
  const stateFor = (key) => {
    const u = unlocked.get(key)
    if (u && u.until <= now()) { unlocked.delete(key); void release() }
    const live = unlocked.get(key)
    return { configured: !!password, unlocked: !!live, env: live?.env ?? null, idleSeconds: live ? Math.round((live.until - now()) / 1000) : 0,
      lockedOutSeconds: lockedUntil > now() ? Math.ceil((lockedUntil - now()) / 1000) : 0 }
  }

  async function unlock(key, body) {
    if (!password) return [503, { error: 'MANAGE_PASSWORD is not set for spec-web' }]
    if (!ENVS.includes(body.env)) return [400, { error: 'unknown environment' }]
    if (lockedUntil > now()) return [429, { error: 'too many wrong passwords; try again later', ...stateFor(key) }]
    if (!same(body.password ?? '', password)) {
      if (++fails >= MAX_TRIES) { lockedUntil = now() + LOCKOUT_MS; fails = 0 }
      return [401, { error: 'wrong password', ...stateFor(key) }]
    }
    fails = 0
    unlocked.set(key, { env: body.env, until: now() + IDLE_MS })
    await release() // switching environment closes the other one's connection
    void Promise.resolve(run({ op: 'warm', env: body.env })).catch(() => {}) // the connection opens now, not on the first search
    return [200, stateFor(key)]
  }

  async function operate(key, actor, body) {
    const u = stateFor(key)
    if (!u.unlocked) return [423, { error: 'locked: enter the manage password', ...u }]
    if (body.env !== u.env) return [423, { error: `unlocked for ${u.env} only; unlock ${body.env} first`, ...u }]
    const op = body.op
    let request
    if (READ_OPS.has(op)) {
      request = { op, env: u.env, actor }
      for (const f of FIELDS) if (body[f] !== undefined) request[f] = body[f]
    } else if (op === 'preview' || op === 'apply') {
      if (!Array.isArray(body.actions)) return [400, { ok: false, kind: 'refused', error: 'actions must be a list' }]
      if (op === 'apply' && !same(body.token ?? '', token(key, u.env, body.actions))) {
        return [409, { ok: false, kind: 'refused', error: 'preview these changes first' }]
      }
      request = { op, env: u.env, actor, actions: body.actions }
    } else {
      return [400, { ok: false, kind: 'refused', error: 'unknown operation' }]
    }
    unlocked.get(key).until = now() + IDLE_MS
    const answer = await run(request)
    if (op === 'preview' && answer.ok) answer.token = token(key, u.env, body.actions)
    return [200, answer]
  }

  const handle = async function handle(req, res, url, { key, actor }) {
    const path = url.pathname
    if (path === '/manage/page' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(await readFile(resolve(HERE, 'page.html'), 'utf8'))
      return true
    }
    if (!path.startsWith('/api/manage/')) return false
    const send = ([status, body]) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
      return true
    }
    if (path === '/api/manage/state' && req.method === 'GET') return send([200, stateFor(key)])
    if (req.method !== 'POST') return send([405, { error: 'POST only' }])
    let body
    try { body = await readJson(req) } catch (err) { return send([400, { error: err.message }]) }
    if (path === '/api/manage/unlock') return send(await unlock(key, body))
    if (path === '/api/manage/lock') { unlocked.delete(key); await release(); return send([200, stateFor(key)]) }
    if (path === '/api/manage/run') return send(await operate(key, actor, body))
    return send([404, { error: 'not found' }])
  }
  handle.sweep = sweep
  return handle
}

function readJson(req) {
  return new Promise((ok, bad) => {
    let text = ''
    req.on('data', (d) => { text += d; if (text.length > MAX_BODY) { bad(new Error('request too large')); req.destroy() } })
    req.on('end', () => { try { const v = JSON.parse(text || '{}'); v && typeof v === 'object' && !Array.isArray(v) ? ok(v) : bad(new Error('bad json')) } catch { bad(new Error('bad json')) } })
    req.on('error', bad)
  })
}

async function defaultRelease(envs) {
  if (process.env.SPEC_WEB_IN_DOCKER !== '1') return keepManage(envs)
  const token = process.env.HOST_RUNNER_TOKEN
  if (!token) return
  const base = process.env.HOST_RUNNER_URL || 'http://host.docker.internal:8899'
  await fetch(`${base}/manage/keep`, { method: 'POST', headers: { 'x-runner-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ envs }), signal: AbortSignal.timeout(10_000) })
}

// In Docker the python scripts cannot run (no python, no AWS credentials): hand the request to the host-runner.
async function defaultRunner(request) {
  if (process.env.SPEC_WEB_IN_DOCKER !== '1') return runManage(request)
  const token = process.env.HOST_RUNNER_TOKEN
  if (!token) return { ok: false, kind: 'failed', error: 'HOST_RUNNER_TOKEN is not set for spec-web' }
  const base = process.env.HOST_RUNNER_URL || 'http://host.docker.internal:8899'
  try {
    const r = await fetch(`${base}/manage/run`, { method: 'POST', headers: { 'x-runner-token': token, 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(130_000) })
    return await r.json()
  } catch {
    return { ok: false, kind: 'runner_down', error: 'The host-runner is not running on your PC. Start it: npm run spec:host-runner' }
  }
}
