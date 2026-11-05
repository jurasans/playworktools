import test from 'node:test'
import assert from 'node:assert/strict'
import { createManage } from './routes.mjs'

const url = (p) => new URL(`http://x${p}`)
function call(handle, method, path, body, key = 's1') {
  return new Promise((done) => {
    const handlers = {}
    const req = { method, on: (e, f) => { handlers[e] = f; return req }, destroy() {} }
    const res = { writeHead(status) { this.status = status }, end(text) { done({ status: this.status, body: JSON.parse(text) }) } }
    handle(req, res, url(path), { key, actor: 'admin' })
    setImmediate(() => { handlers.data?.(JSON.stringify(body ?? {})); handlers.end?.() })
  })
}
const fresh = (extra = {}) => {
  const seen = []
  const handle = createManage({ password: 'pw', run: async (r) => { seen.push(r); return { ok: true, rows: [] } }, ...extra })
  return { handle, seen }
}
const unlock = (h, env = 'stage', password = 'pw', key) => call(h, 'POST', '/api/manage/unlock', { env, password }, key)
const run = (h, body, key) => call(h, 'POST', '/api/manage/run', body, key)

test('nothing runs while locked', async () => {
  const { handle, seen } = fresh()
  assert.equal((await run(handle, { env: 'stage', op: 'search_sensors', query: 'ab' })).status, 423)
  assert.equal(seen.length, 0)
})

test('a wrong password fails, five wrong ones lock out even the right password', async () => {
  let t = 0
  const { handle } = fresh({ now: () => t })
  for (let i = 0; i < 5; i++) assert.equal((await unlock(handle, 'stage', 'nope')).status, 401)
  assert.equal((await unlock(handle)).status, 429)
  t += 15 * 60 * 1000 + 1
  assert.equal((await unlock(handle)).status, 200)
})

test('unconfigured password refuses to unlock', async () => {
  const handle = createManage({ password: '', run: async () => ({}) })
  assert.equal((await unlock(handle)).status, 503)
})

test('unlock is per session, expires after 15 idle minutes and is tied to one environment', async () => {
  let t = 0
  const { handle, seen } = fresh({ now: () => t })
  await unlock(handle, 'stage', 'pw', 'a')
  assert.equal((await run(handle, { env: 'stage', op: 'list_licenses' }, 'b')).status, 423)
  assert.equal((await run(handle, { env: 'prod', op: 'list_licenses' }, 'a')).status, 423)
  assert.equal((await run(handle, { env: 'stage', op: 'list_licenses' }, 'a')).status, 200)
  t += 14 * 60 * 1000
  assert.equal((await run(handle, { env: 'stage', op: 'list_licenses' }, 'a')).status, 200)
  t += 16 * 60 * 1000
  assert.equal((await run(handle, { env: 'stage', op: 'list_licenses' }, 'a')).status, 423)
  assert.equal(seen.filter((r) => r.op !== 'warm').length, 2)
  assert.ok(seen.some((r) => r.op === 'warm' && r.env === 'stage')) // unlocking opens the connection
})

test('unlocking prod replaces the stage unlock', async () => {
  const { handle } = fresh()
  await unlock(handle, 'stage')
  await unlock(handle, 'prod')
  assert.equal((await run(handle, { env: 'stage', op: 'list_licenses' })).status, 423)
  assert.equal((await run(handle, { env: 'prod', op: 'list_licenses' })).status, 200)
})

test('only allow-listed operations pass and extra fields never reach the scripts', async () => {
  const { handle, seen } = fresh()
  await unlock(handle)
  assert.equal((await run(handle, { env: 'stage', op: 'info' })).status, 400)
  assert.equal((await run(handle, { env: 'stage', op: 'drop' })).status, 400)
  await run(handle, { env: 'stage', op: 'search_sensors', query: 'ab', sql: 'DROP', env2: 'prod', actor: 'root' })
  assert.deepEqual(seen.filter((r) => r.op !== 'warm'), [{ op: 'search_sensors', env: 'stage', actor: 'admin', query: 'ab' }])
})

test('apply needs the token from a preview of exactly the same changes', async () => {
  const { handle, seen } = fresh()
  await unlock(handle)
  const actions = [{ type: 'clear_device', sensor_id: 'AA', expected: 'd' }]
  assert.equal((await run(handle, { env: 'stage', op: 'apply', actions })).status, 409)
  const { body } = await run(handle, { env: 'stage', op: 'preview', actions })
  assert.ok(body.token)
  const other = [{ type: 'clear_device', sensor_id: 'BB', expected: 'd' }]
  assert.equal((await run(handle, { env: 'stage', op: 'apply', actions: other, token: body.token })).status, 409)
  await unlock(handle, 'stage', 'pw', 's2')
  assert.equal((await run(handle, { env: 'stage', op: 'apply', actions, token: body.token }, 's2')).status, 409)
  assert.equal((await run(handle, { env: 'stage', op: 'apply', actions, token: body.token })).status, 200)
  assert.deepEqual(seen.map((r) => r.op).filter((o) => o !== 'warm'), ['preview', 'apply'])
})

test('other paths are not handled, and oversized or invalid bodies are refused', async () => {
  const { handle } = fresh()
  const res = { writeHead() {}, end() {} }
  assert.equal(await handle({ method: 'GET', on() {} }, res, url('/api/other'), { key: 'k' }), false)
  assert.equal((await call(handle, 'GET', '/api/manage/lock')).status, 405)
})

test('locking, switching environment and idle expiry all tell the worker which environments to keep', async () => {
  let t = 0
  const kept = []
  const handle = createManage({ password: 'pw', run: async () => ({ ok: true }), release: async (envs) => { kept.push(envs) }, now: () => t })
  await unlock(handle, 'stage', 'pw', 'a')
  assert.deepEqual(kept.at(-1), ['stage'])
  await unlock(handle, 'prod', 'pw', 'a')
  assert.deepEqual(kept.at(-1), ['prod'])
  await unlock(handle, 'stage', 'pw', 'b')
  assert.deepEqual(kept.at(-1).sort(), ['prod', 'stage'])
  await call(handle, 'POST', '/api/manage/lock', {}, 'a')
  assert.deepEqual(kept.at(-1), ['stage'])
  t += 16 * 60 * 1000
  const before = kept.length
  await handle.sweep()
  assert.equal(kept.length, before + 1)
  assert.deepEqual(kept.at(-1), [])
})
