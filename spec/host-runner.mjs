#!/usr/bin/env node
// Runs the test suites on the actual host for spec-web (in Docker). See
// tools/spec-web/README.md "Test running (host-runner)" for why this exists
// and how it's reached. Start with: npm run spec:host-runner
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'
import { validRunId, startWorker } from '../spec-web/runs-lib.mjs'
import { rewriteWithClaude } from '../spec-web/images-rewrite.mjs'
import { runManage, keepManage } from '../manage/web/run-python.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RUN_FULL_SUITE_SCRIPT = resolve(ROOT, 'tools', 'spec', 'run-full-suite.mjs')

const AGENT_RUN_SCRIPT = resolve(ROOT, 'tools', 'spec', 'agent-run.mjs')

const PORT =Number(process.env.HOST_RUNNER_PORT || 8899)
const RUNNER_TOKEN = process.env.HOST_RUNNER_TOKEN || 'YANI_TOMER_ILIA_RUNNER'

function tokenOk(given) {
  if (typeof given !== 'string' || !given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(RUNNER_TOKEN)
  return a.length === b.length && timingSafeEqual(a, b)
}

let running = false
let imagesRunning = false

const server = createServer((req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }

  if (req.url === '/health' && req.method === 'GET') {
    return json(200, { ok: true, running })
  }

  if (req.url === '/run' && req.method === 'POST') {
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    running = true
    const child = spawn(process.execPath, [RUN_FULL_SUITE_SCRIPT], { cwd: ROOT, stdio: 'inherit', detached: true })
    child.unref()
    child.on('exit', () => { running = false })
    return json(200, { ok: true, started: true })
  }

  // Headless Claude run (S-282): spec-web already wrote the run file; this only spawns its worker on the host.
  if (req.url === '/agent/start' && req.method === 'POST') {
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy() })
    req.on('end', () => {
      let runId
      try { runId = JSON.parse(body).runId } catch { return json(400, { error: 'bad json' }) }
      if (!validRunId(runId)) return json(400, { error: 'bad run id' })
      startWorker(runId)
      json(200, { ok: true, started: true })
    })
    return
  }

  // Rewrites a person's image notes into prompt wording with the Claude CLI (which only exists here on the host).
  if (req.url === '/prompt/rewrite' && req.method === 'POST') {
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 16384) req.destroy() })
    req.on('end', async () => {
      let args
      try { args = JSON.parse(body) } catch { return json(400, { error: 'bad json' }) }
      const clip = (v, n) => String(v || '').slice(0, n)
      const result = await rewriteWithClaude({ subject: clip(args.subject, 200), basePrompt: clip(args.basePrompt, 2000), notes: clip(args.notes, 4000), mustAvoid: Array.isArray(args.mustAvoid) ? args.mustAvoid.slice(0, 30).map((t) => clip(t, 100)) : [], kind: args.kind === 'audio' ? 'audio' : 'image' })
      json(200, { result })
    })
    return
  }

  // Space Chase art queue (spec-web Images tab): the container cannot reach the host GPU, so the host runs the queue runner.
  if ((req.url === '/images/run' || req.url === '/gen/run') && req.method === 'POST') {
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    if (imagesRunning) return json(200, { ok: true, started: false, already: true })
    imagesRunning = true
    const child = spawn(process.execPath, [resolve(ROOT, 'tools', 'generate', 'gen-queue-runner.mjs')], { cwd: ROOT, stdio: 'inherit' })
    child.on('error', () => { imagesRunning = false })
    child.on('exit', () => { imagesRunning = false })
    return json(200, { ok: true, started: true })
  }

  // Prod/stage license manage scripts (tools/manage). Never on the built-in default token: it can write to the database.
  if (req.url === '/manage/run' && req.method === 'POST') {
    if (!process.env.HOST_RUNNER_TOKEN || process.env.HOST_RUNNER_TOKEN.length < 24) return json(403, { error: 'set a HOST_RUNNER_TOKEN of 24+ characters to use /manage/run' })
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 131072) req.destroy() })
    req.on('end', async () => {
      let request
      try { request = JSON.parse(body) } catch { return json(400, { error: 'bad json' }) }
      json(200, await runManage(request))
    })
    return
  }

  // Closes the manage worker's database connections for every environment not listed (all of them when empty).
  if (req.url === '/manage/keep' && req.method === 'POST') {
    if (!process.env.HOST_RUNNER_TOKEN || process.env.HOST_RUNNER_TOKEN.length < 24) return json(403, { error: 'set a HOST_RUNNER_TOKEN of 24+ characters' })
    if (!tokenOk(req.headers['x-runner-token'])) return json(401, { error: 'bad or missing token' })
    let body = ''
    req.on('data', (d) => { body += d; if (body.length > 1024) req.destroy() })
    req.on('end', async () => {
      let envs
      try { envs = JSON.parse(body).envs } catch { return json(400, { error: 'bad json' }) }
      if (!Array.isArray(envs)) return json(400, { error: 'envs must be a list' })
      await keepManage(envs.filter((e) => typeof e === 'string'))
      json(200, { ok: true })
    })
    return
  }

  json(404, { error: 'not found' })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log('')
  console.log('  host-runner — runs the test suites on the host, for spec-web (in Docker)')
  console.log(`  listening : 0.0.0.0:${PORT}`)
  console.log(`  reachable from the container as: http://host.docker.internal:${PORT}`)
  console.log('  keep this running whenever you want the spec-web TEST button to work')
  console.log('')
})
