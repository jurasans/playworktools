#!/usr/bin/env node
/**
 * nightly-run.mjs — the one entry point the nightly scheduled task calls.
 *
 * Runs, in order, and independently of each other (one step failing does not
 * skip the rest): the web dev build (so it is available for review first), unit tests, e2e tests, the device-matrix screenshot suite
 * (all three via record-test-run.mjs, so their results land in
 * tools/spec-web/documentation/state/test-status.json exactly as an interactive run would),
 * then a debug Android APK build whose output is copied to a fixed path
 * spec-web can serve for download, alongside a small manifest.json with
 * version/commit/size/build-time metadata. A clean debug APK of the master branch is built too, in a separate git worktree
 * (the working tree is never touched) and skipped when one from the current master commit exists (--master-only / --no-master). The very last step translates the English manual into the other
 * languages with Ollama (manual-translate.mjs sync); it is skipped, not failed, when Ollama is down.
 *
 * Intended to be invoked by a host-level scheduler (Windows Task Scheduler),
 * NOT the CronCreate tool — CronCreate jobs are session-scoped (in-memory,
 * gone when the Claude session ends, and auto-expire after 7 days even while
 * a session is alive), which is the wrong lifetime for "run every night
 * indefinitely". See docs/nightly-build.md for the schtasks registration
 * command.
 *
 * Usage: node tools/spec/nightly-run.mjs
 * Log:   tools/spec-web/documentation/state/nightly-log.txt (overwritten each run; the
 *        step-by-step console output is also echoed to stdout for when this
 *        is run interactively).
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, cpSync, statSync, existsSync, appendFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ilTime } from '../spec-web/runs-lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const DATA_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state')
const DOWNLOADS_DIR = resolve(DATA_DIR, 'downloads')
const LOG_FILE = resolve(DATA_DIR, 'nightly-log.txt')
const APK_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const APK_DEST = resolve(DOWNLOADS_DIR, 'playwork-debug-latest.apk')
const MANIFEST_DEST = resolve(DOWNLOADS_DIR, 'manifest.json')
const PROD_APK_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const PROD_APK_DEST = resolve(DOWNLOADS_DIR, 'playwork-prod-latest.apk')

mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(DOWNLOADS_DIR, { recursive: true })
writeFileSync(LOG_FILE, `[nightly-run] started ${ilTime(new Date(), true)}\n`)

// When a run (finish-ready-stubs, spec-web) owns the amber banner, each stage shows up under it as a sub-step with a
// spinner while it runs. A standalone nightly leaves the banner alone, and a failed update never stops the run.
const SPEC_CLI = resolve(ROOT, 'tools', 'spec', 'spec.mjs')
let bannerIsWip = false
try { bannerIsWip = JSON.parse(spawnSync(process.execPath, [SPEC_CLI, 'state', 'get', '--json'], { cwd: ROOT, encoding: 'utf8' }).stdout).state === 'wip' } catch { /* no banner state */ }
function stage(label, status) {
  if (!bannerIsWip) return
  try { spawnSync(process.execPath, [SPEC_CLI, 'state', 'checklist-set', `Nightly: ${label}`, status], { cwd: ROOT, stdio: 'ignore' }) } catch { /* banner is best-effort */ }
}
const stageResult = (label, pass) => stage(label, pass ? 'done' : 'failed')

function log(line) {
  const s = `${line}\n`
  process.stdout.write(s)
  appendFileSync(LOG_FILE, s)
}

// Runs a command to completion, streaming output into the shared log, and
// resolves with its exit code rather than rejecting — every step here is
// independent, so a non-zero exit must not stop the remaining steps.
function run(cmd, args, opts = {}) {
  return new Promise((res) => {
    const full = [cmd, ...args].join(' ')
    log(`\n[nightly-run] $ ${full}`)
    const child = spawn(full, { cwd: ROOT, shell: true, ...opts })
    child.stdout?.on('data', (d) => { process.stdout.write(d); appendFileSync(LOG_FILE, d) })
    child.stderr?.on('data', (d) => { process.stderr.write(d); appendFileSync(LOG_FILE, d) })
    child.on('close', (code) => res(code ?? 1))
    child.on('error', (err) => { log(`[nightly-run] spawn error: ${err.message}`); res(1) })
  })
}

// ── Clean build of the master branch ─────────────────────────────────────────────────────────────────────────────
// Builds a debug APK of exactly what is on `master`, in a separate git worktree under state/master-build, so the working tree,
// the checked-out branch, the index and every uncommitted change stay untouched (nothing is checked out or stashed). The
// worktree is removed afterwards and the git state is compared with what it was before, as the proof. Skipped when an APK
// built from the current master commit already exists.
const MASTER_APK_DEST = resolve(DOWNLOADS_DIR, 'playwork-master-latest.apk')
const MASTER_DIR = resolve(DATA_DIR, 'master-build')
const gitOut = (args) => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
const gitState = () => JSON.stringify({ head: gitOut(['rev-parse', 'HEAD']), branch: gitOut(['branch', '--show-current']), status: gitOut(['status', '--porcelain']), stash: gitOut(['stash', 'list']) })

function dropWorktree() {
  spawnSync('git', ['worktree', 'remove', '--force', MASTER_DIR], { cwd: ROOT })
  rmSync(MASTER_DIR, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT })
}

async function masterBuild(results) {
  log(`\n${'='.repeat(60)}\n[nightly-run] step: clean master build (debug APK)\n${'='.repeat(60)}`)
  stage('master build', 'active')
  const commit = gitOut(['rev-parse', '--verify', 'master'])
  if (!commit) { log('[nightly-run] no master branch here: master build skipped'); results.masterApk = 'skipped'; stage('master build', 'failed'); return }
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(MANIFEST_DEST, 'utf8')) } catch { /* no manifest yet */ }
  if (manifest.master?.commit === commit && existsSync(MASTER_APK_DEST)) {
    log(`[nightly-run] an APK from master ${commit.slice(0, 7)} already exists: master build skipped`)
    results.masterApk = 'skipped (up to date)'
    stage('master build', 'done')
    return
  }
  const before = gitState()
  let ok = false
  try {
    dropWorktree()   // a leftover from an interrupted run
    if (spawnSync('git', ['worktree', 'add', '--detach', MASTER_DIR, commit], { cwd: ROOT }).status !== 0) throw new Error('git worktree add failed')
    // The app source is master's; the Android build SCRIPT is the current one (it is tooling, and master's copy cannot scaffold a
    // fresh android/ project: it pins Kotlin to Java 17 while Capacitor 8 compiles with 21).
    // The whole tools/build folder travels together: the script finds its siblings (icon generator) relative to itself, and an older master still has them under scripts/.
    cpSync(resolve(ROOT, 'tools', 'build'), resolve(MASTER_DIR, 'tools', 'build'), { recursive: true })
    // A clean install from master's own lockfile, inside the worktree. The dependencies are deliberately NOT shared with this
    // working tree (no link): the build script runs `npm install`, which would otherwise rewrite this tree's node_modules.
    if ((await run('npm', ['ci', '--silent'], { cwd: MASTER_DIR })) !== 0) throw new Error('npm ci failed in the master worktree')
    const code = await run('bash', ['tools/build/build-android.sh', '--no-install'], { cwd: MASTER_DIR })
    const apk = resolve(MASTER_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    if (code !== 0 || !existsSync(apk)) throw new Error(`master APK build ${code === 0 ? 'produced no APK' : 'failed'}`)
    copyFileSync(apk, MASTER_APK_DEST)
    let version = {}
    try { version = JSON.parse(readFileSync(resolve(MASTER_DIR, 'version.json'), 'utf8')) } catch { /* optional */ }
    try { manifest = JSON.parse(readFileSync(MANIFEST_DEST, 'utf8')) } catch { /* keep what we had */ }
    manifest.master = {
      builtAt: new Date().toISOString(), commit, shortCommit: commit.slice(0, 7), branch: 'master',
      subject: gitOut(['log', '-1', '--format=%s', commit]), committedAt: gitOut(['log', '-1', '--format=%cI', commit]),
      sizeBytes: statSync(MASTER_APK_DEST).size, versionName: version.version ?? null, versionCode: version.versionCode ?? null,
      channel: 'dev', licenseApi: 'stage', filename: 'playwork-master-latest.apk',
    }
    writeFileSync(MANIFEST_DEST, JSON.stringify(manifest, null, 2) + '\n')
    ok = true
    log(`[nightly-run] master APK (${commit.slice(0, 7)}) published to ${MASTER_APK_DEST}`)
  } catch (err) {
    log(`[nightly-run] master build failed: ${err.message}`)
  } finally {
    dropWorktree()
    const after = gitState()
    log(after === before ? '[nightly-run] git state is exactly as before the master build (branch, HEAD, changes, stash)' : '[nightly-run] WARNING: the git state differs after the master build; check `git status`')
  }
  results.masterApk = ok ? 'pass' : 'fail'
  stageResult('master build', ok)
}

async function main() {
  const results = {}
  // --apk-only: just rebuild and publish the debug APK (skips the web build and the test suites).
  const apkOnly = process.argv.includes('--apk-only')
  // --master-only: just the clean master build (it is also a step of the full run, skipped with --no-master).
  if (process.argv.includes('--master-only')) {
    await masterBuild(results)
    log(`\n${'='.repeat(60)}\n[nightly-run] done — ${JSON.stringify(results)}\n${'='.repeat(60)}`)
    return
  }

  // Web build first: it takes about a minute and is the fastest thing to open in a browser, so it is
  // ready long before the tests and the APK finish.
  if (!apkOnly) {
    log(`\n${'='.repeat(60)}\n[nightly-run] step: web dev build (Chrome)\n${'='.repeat(60)}`)
    stage('web build', 'active')
    results.webBuild = (await run('node', ['tools/build/build-web-dev.mjs'])) === 0 ? 'pass' : 'fail'
    stageResult('web build', results.webBuild === 'pass')
  }

  for (const suite of apkOnly ? [] : ['unit', 'e2e', 'screenshots']) {
    log(`\n${'='.repeat(60)}\n[nightly-run] step: ${suite} tests\n${'='.repeat(60)}`)
    stage(`${suite} tests`, 'active')
    const code = await run('node', ['tools/spec/record-test-run.mjs', suite])
    results[suite] = code === 0 ? 'pass' : 'fail'
    stageResult(`${suite} tests`, code === 0)
  }

  log(`\n${'='.repeat(60)}\n[nightly-run] step: debug APK build\n${'='.repeat(60)}`)
  // --no-install: this host has no device attached for a scheduled run; the
  // point of this step is producing a downloadable artifact, not installing.
  stage('APK build', 'active')
  const buildCode = await run('bash', ['tools/build/build-android.sh', '--no-install'])
  results.apkBuild = buildCode === 0 ? 'pass' : 'fail'
  stageResult('APK build', buildCode === 0)

  if (buildCode === 0 && existsSync(APK_SRC)) {
    try {
      copyFileSync(APK_SRC, APK_DEST)
      const { size, mtime } = statSync(APK_DEST)
      let version = {}
      try {
        version = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(resolve(ROOT, 'version.json'), 'utf8')))
      } catch { /* version.json missing/unreadable — manifest just omits it */ }
      let gitCommit = null, gitBranch = null
      try {
        gitCommit = (await new Promise((res) => {
          const c = spawn('git rev-parse --short HEAD', { cwd: ROOT, shell: true })
          let out = ''
          c.stdout.on('data', (d) => (out += d))
          c.on('close', () => res(out.trim() || null))
        }))
        gitBranch = (await new Promise((res) => {
          const c = spawn('git branch --show-current', { cwd: ROOT, shell: true })
          let out = ''
          c.stdout.on('data', (d) => (out += d))
          c.on('close', () => res(out.trim() || null))
        }))
      } catch { /* git metadata is best-effort */ }

      let prevManifest = {}
      try { prevManifest = JSON.parse(readFileSync(MANIFEST_DEST, 'utf8')) } catch { /* first run */ }
      writeFileSync(MANIFEST_DEST, JSON.stringify({
        ...(prevManifest.prod ? { prod: prevManifest.prod } : {}),
        ...(prevManifest.master ? { master: prevManifest.master } : {}),
        builtAt: new Date().toISOString(),
        sizeBytes: size,
        versionName: version.version ?? null,
        versionCode: version.versionCode ?? null,
        gitCommit, gitBranch,
        // The debug APK is a dev build: staging API unless VITE_LICENSE_ENV=prod is forced in this shell.
        licenseApi: process.env.VITE_LICENSE_ENV === 'prod' ? 'prod' : 'stage',
        filename: 'playwork-debug-latest.apk',
      }, null, 2) + '\n')
      log(`[nightly-run] APK copied to ${APK_DEST} (${(size / 1024 / 1024).toFixed(1)} MB)`)
      results.apkPublish = 'pass'
    } catch (err) {
      log(`[nightly-run] APK copy/manifest step failed: ${err.message}`)
      results.apkPublish = 'fail'
    }
  } else {
    log(`[nightly-run] skipping APK publish — build ${buildCode === 0 ? 'succeeded but output not found' : 'failed'}`)
    results.apkPublish = 'skipped'
  }

  // Production APK: signed release build on the prod channel, so it reports analytics and crashes to Firebase and uses the
  // prod license API. Version and versionCode stay untouched (playwork-build.js --nightly). It runs after the debug APK is
  // published because both build into android/ and the prod web bundle differs. No keystore: skipped, not failed.
  if (!process.argv.includes('--debug-only')) {
    log(`\n${'='.repeat(60)}\n[nightly-run] step: production APK build (reports to Firebase)\n${'='.repeat(60)}`)
    stage('prod APK build', 'active')
    if (!existsSync(resolve(ROOT, 'android', 'keystore.properties'))) {
      log('[nightly-run] android/keystore.properties not found: production APK skipped')
      results.prodApk = 'skipped'
      stage('prod APK build', 'failed')
    } else {
      const prodCode = await run('node', ['tools/build/playwork-build.js', '--nightly'])
      if (prodCode === 0 && existsSync(PROD_APK_SRC)) {
        try {
          copyFileSync(PROD_APK_SRC, PROD_APK_DEST)
          const { size } = statSync(PROD_APK_DEST)
          let version = {}
          try { version = JSON.parse(readFileSync(resolve(ROOT, 'version.json'), 'utf8')) } catch { /* optional */ }
          const git = (a) => { try { return spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim() || null } catch { return null } }
          let manifest = {}
          try { manifest = JSON.parse(readFileSync(MANIFEST_DEST, 'utf8')) } catch { /* the debug step normally wrote it */ }
          manifest.prod = {
            builtAt: new Date().toISOString(), sizeBytes: size, versionName: version.version ?? null, versionCode: version.versionCode ?? null,
            gitCommit: git(['rev-parse', '--short', 'HEAD']), gitBranch: git(['branch', '--show-current']),
            channel: 'prod', reportsToFirebase: true, licenseApi: 'prod', filename: 'playwork-prod-latest.apk',
          }
          writeFileSync(MANIFEST_DEST, JSON.stringify(manifest, null, 2) + '\n')
          log(`[nightly-run] production APK copied to ${PROD_APK_DEST} (${(size / 1024 / 1024).toFixed(1)} MB)`)
          results.prodApk = 'pass'
        } catch (err) {
          log(`[nightly-run] production APK copy/manifest step failed: ${err.message}`)
          results.prodApk = 'fail'
        }
      } else {
        log(`[nightly-run] production APK build ${prodCode === 0 ? 'succeeded but output not found' : 'failed'}`)
        results.prodApk = 'fail'
      }
      stageResult('prod APK build', results.prodApk === 'pass')
    }
  }

  if (!process.argv.includes('--no-master') && !apkOnly) await masterBuild(results)

  // Last step, once everything else is finished: translate the English manual into every other language
  // (Ollama container). Agents only ever write docs/manual/en; this is the one place the other languages change.
  if (!apkOnly) {
    log(`\n${'='.repeat(60)}\n[nightly-run] step: manual translation (Ollama)\n${'='.repeat(60)}`)
    stage('manual translation', 'active')
    if ((await run('node', ['tools/i18n/manual-translate.mjs', 'status'])) !== 0) {
      log('[nightly-run] Ollama is not reachable or the translation model is missing: manual translation skipped (it catches up on the next night)')
      results.manualTranslation = 'skipped'
      stage('manual translation', 'failed')
    } else {
      const code = await run('node', ['tools/i18n/manual-translate.mjs', 'sync', '--lang', 'all', '--save', '--prune'])
      results.manualTranslation = code === 0 ? 'pass' : 'fail'
      stageResult('manual translation', code === 0)
    }
  }

  log(`\n${'='.repeat(60)}\n[nightly-run] done — ${JSON.stringify(results)}\n${'='.repeat(60)}`)
}

main()
