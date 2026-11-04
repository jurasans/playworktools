#!/usr/bin/env node
/**
 * build-web-dev.mjs — builds the app for a desktop browser (Chrome), dev
 * channel (never reports to Firebase, see buildChannel.ts), into
 * tools/spec-web/documentation/state/webapp/. spec-web serves it on its own
 * origin under /web-build/ (behind the tool's normal login; base path set via
 * VITE_BASE, and server.mjs maps the app's hard-coded /images|audio|videos/ paths):
 *   app/ - ONE build for both modes: real Web Bluetooth by default, three fake balls
 *          (no hardware or network) when opened with ?mock=1, back with ?mock=0
 *          (src/utils/runtimeMock.ts, built in via VITE_ALLOW_RUNTIME_MOCK)
 * Runs on the host (the spec-web container cannot build: its node_modules are
 * the Windows ones). Called by nightly-run.mjs and by `npm run build:web-dev`.
 *
 * Usage: node tools/build/build-web-dev.mjs   (the two-ball games are a runtime switch in the built app: ?twoball=1 / ?twoball=0)
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, cpSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'webapp')
// Staging license API (the prod API only allows the production web origin in its CORS) and no analytics at all.
const STAGING_API = process.env.WEB_BUILD_LICENSE_API_URL || 'https://dev-api.goplaywork.com'
const VARIANTS = { app: { VITE_SENSOR_TARGET: 'web-ble', VITE_ALLOW_RUNTIME_MOCK: 'true', VITE_BASE: '/web-build/', VITE_LICENSE_API_URL: STAGING_API, VITE_DISABLE_ANALYTICS: 'true' } }

function build(name, extraEnv) {
  return new Promise((res) => {
    const outDir = resolve(OUT, name)
    // Build into a sibling dir first, then swap, so a failed build never leaves a half-empty site.
    const tmp = outDir + '.tmp'
    rmSync(tmp, { recursive: true, force: true })
    const cmd = `npx vite build --outDir "${tmp}" --emptyOutDir`
    console.log(`[build-web-dev] ${name}: ${cmd}`)
    const child = spawn(cmd, {
      cwd: ROOT, shell: true, stdio: 'inherit',
      env: { ...process.env, VITE_BUILD_CHANNEL: 'dev', ...extraEnv },
    })
    child.on('close', (code) => {
      if (code !== 0 || !existsSync(resolve(tmp, 'index.html'))) { console.log(`[build-web-dev] ${name}: FAILED (${code})`); return res(false) }
      rmSync(outDir, { recursive: true, force: true })
      // Copy then delete rather than rename: Windows refuses to rename a directory that anything (antivirus, an open handle) still touches.
      cpSync(tmp, outDir, { recursive: true }); rmSync(tmp, { recursive: true, force: true })
      res(true)
    })
    child.on('error', () => res(false))
  })
}

const want = Object.keys(VARIANTS)
mkdirSync(OUT, { recursive: true })

let commit = null, branch = null, version = null
try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() } catch { /* best effort */ }
try { branch = execSync('git branch --show-current', { cwd: ROOT }).toString().trim() } catch { /* best effort */ }
try { version = JSON.parse(readFileSync(resolve(ROOT, 'version.json'), 'utf8')).version ?? null } catch { /* optional */ }

const results = {}
for (const name of want) results[name] = await build(name, VARIANTS[name])

const manifestPath = resolve(OUT, 'manifest.json')
let prev = {}
try { prev = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* first run */ }
const now = new Date().toISOString()
const manifest = { ...prev, commit, branch, version }
for (const name of want) if (results[name]) manifest[name] = { builtAt: now }
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log('[build-web-dev] done', JSON.stringify(results))
process.exit(Object.values(results).every(Boolean) ? 0 : 1)
