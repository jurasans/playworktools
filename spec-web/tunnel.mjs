#!/usr/bin/env node
/**
 * Starts the spec-web server and a Cloudflare quick tunnel in front of it,
 * then prints the ONE public URL that already carries the access token.
 *
 * `cloudflared tunnel --url` needs no Cloudflare account: it mints a random
 * *.trycloudflare.com hostname that lives only as long as this process.
 *
 * If something is already listening on --port (a bare `node server.mjs` you
 * started yourself, or the Docker container from docker-compose.yml), this
 * ATTACHES to it instead of spawning a second copy — spawning would just
 * collide on the port. In attach mode the token isn't visible to this
 * process (it was printed by whichever process is actually listening), so
 * pass it via --token or SPEC_WEB_TOKEN if you want the printed tunnel URL
 * to already carry it.
 *
 * Usage:  node tools/spec-web/tunnel.mjs [--port 8888] [--protocol http2] [--token …]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argVal = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const PORT = argVal('--port', '8888')
const PROTOCOL = argVal('--protocol', '')   // '' = auto (quic), or http2

// cloudflared is not on PATH right after a winget install until the shell is
// restarted, so probe the known install locations before giving up.
const CANDIDATES = [
  process.env.CLOUDFLARED,
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  '/usr/local/bin/cloudflared',
  '/opt/homebrew/bin/cloudflared',
].filter(Boolean)
const cfBin = CANDIDATES.find((p) => existsSync(p)) || 'cloudflared'

let srv = null
let token = argVal('--token', process.env.SPEC_WEB_TOKEN || null)

async function probeOnce(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`)
    return true
  } catch {
    return false
  }
}

async function waitForServer(port, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await probeOnce(port)) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Server did not become reachable on port ${port}`)
}

async function main() {
  if (await probeOnce(PORT)) {
    console.log(`→ found a server already listening on 127.0.0.1:${PORT} — attaching (not spawning a second one)`)
    if (!token) console.log('  (no --token / SPEC_WEB_TOKEN given — check that server\'s own log for the token to append)')
    await startTunnel()
    return
  }

  console.log('→ starting spec-web…')
  srv = spawn(process.execPath, [resolve(HERE, 'server.mjs'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  let tunnelStarted = false
  srv.stdout.on('data', (buf) => {
    const s = buf.toString()
    process.stdout.write(s)
    const m = s.match(/token\s*:\s*([a-f0-9]{16,})/i)
    if (m) token = m[1]
    if (!tunnelStarted && /local\s*:/.test(s)) { tunnelStarted = true; startTunnel() }
  })
}

async function startTunnel() {
  console.log('→ opening Cloudflare quick tunnel…')
  await waitForServer(PORT)
  const args = [
    'tunnel',
    '--url',
    `http://127.0.0.1:${PORT}`,
    '--no-autoupdate',
  ]

  if (PROTOCOL) args.push('--protocol', PROTOCOL)

  const cf = spawn(cfBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const scan = (buf) => {
    const s = buf.toString()
    const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m) {
      const url = token ? `${m[0]}/?t=${token}` : m[0]
      console.log('\n' + '─'.repeat(72))
      console.log('  PUBLIC URL (token included — treat it as the password):')
      console.log('  ' + url)
      console.log('─'.repeat(72) + '\n')
    }
    if (/ERR|failed to|unable to/i.test(s)) process.stderr.write(s)
  }
  cf.stdout.on('data', scan)
  cf.stderr.on('data', scan)   // cloudflared logs to stderr
  cf.on('exit', (c) => console.log(`cloudflared exited (${c})`))

  const bye = () => { cf.kill(); srv?.kill(); process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
}

main().catch((e) => { console.error(e); process.exit(1) })
