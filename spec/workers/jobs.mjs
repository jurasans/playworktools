// The nightly's stages as independent jobs. Each has a heading (the log line the Rebuild button reads), a short label (the
// checklist item on the site), a time budget (timeoutMs overall, idleMs without output) and optionally a skipReason() that
// says why the stage is not needed. run() returns true, false, or { skipped: reason }.
// Run one alone: node tools/spec/workers/worker.mjs <name>
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { progress, childRange } from '../../build/progress.mjs'
import { GIT_BASH } from '../../build/find-bash.mjs'
import { ROOT, DATA_DIR, DOWNLOADS_DIR, MIN, gitOut, readManifest, writeManifest, readVersion, builtAlready } from './lib.mjs'
import { runLimited } from './runner.mjs'

const out = (d) => process.stdout.write(d)
// One command, its output streamed into the worker's stdout; 124 means a budget killed it.
const sh = async (cmd, args = [], { cwd = ROOT, env, quiet } = {}) => (await runLimited({ cmd, args, cwd, env, onData: quiet ? undefined : out })).code
const say = (s) => out(`${s}\n`)
const mb = (n) => (n / 1024 / 1024).toFixed(1)

const APK_DEBUG_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const APK_DEBUG_DEST = resolve(DOWNLOADS_DIR, 'playwork-debug-latest.apk')
const APK_PROD_SRC = resolve(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
const APK_PROD_DEST = resolve(DOWNLOADS_DIR, 'playwork-prod-latest.apk')
const APK_MASTER_DEST = resolve(DOWNLOADS_DIR, 'playwork-master-latest.apk')
const MASTER_DIR = resolve(DATA_DIR, 'master-build')
const gitHead = () => gitOut(['rev-parse', '--short', 'HEAD'])

const command = (heading, label, args, timeoutMs, idleMs) => ({ heading, label, timeoutMs, idleMs, run: async () => (await sh('node', args)) === 0 })

const apkDebug = {
  heading: 'debug APK build', label: 'debug APK', timeoutMs: 45 * MIN, idleMs: 15 * MIN,
  skipReason: () => builtAlready('', APK_DEBUG_DEST),
  async run() {
    // --no-install: a scheduled run has no device attached; the point is a downloadable artifact.
    const code = await sh(`"${GIT_BASH}"`, ['tools/build/build-android.sh', '--no-install'])
    if (code !== 0 || !existsSync(APK_DEBUG_SRC)) { say(`[nightly-run] skipping APK publish — build ${code === 0 ? 'succeeded but output not found' : 'failed'}`); return false }
    copyFileSync(APK_DEBUG_SRC, APK_DEBUG_DEST)
    const { size } = statSync(APK_DEBUG_DEST)
    const version = readVersion()
    const prev = readManifest()
    writeManifest({
      ...(prev.prod ? { prod: prev.prod } : {}), ...(prev.master ? { master: prev.master } : {}), ...(prev.chinese ? { chinese: prev.chinese } : {}),
      builtAt: new Date().toISOString(), sizeBytes: size, versionName: version.version ?? null, versionCode: version.versionCode ?? null,
      gitCommit: gitHead(), gitBranch: gitOut(['branch', '--show-current']),
      // Who built it: the nightly, or a Start working run (BUILD_SOURCE=WI-n), shown on the Downloads card.
      builtBy: process.env.BUILD_SOURCE || 'nightly',
      licenseApi: process.env.VITE_LICENSE_ENV === 'prod' ? 'prod' : 'stage',
      filename: 'playwork-debug-latest.apk',
    })
    say(`[nightly-run] APK copied to ${APK_DEBUG_DEST} (${mb(size)} MB)`)
    return true
  },
}

// Signed release build on the prod channel (reports to Firebase, prod license API); version and versionCode stay untouched.
const apkProd = {
  heading: 'production APK build (reports to Firebase)', label: 'prod APK', timeoutMs: 45 * MIN, idleMs: 15 * MIN,
  skipReason: () => (existsSync(resolve(ROOT, 'android', 'keystore.properties')) ? builtAlready('prod', APK_PROD_DEST) : 'android/keystore.properties not found'),
  async run() {
    const code = await sh('node', ['tools/build/playwork-build.js', '--nightly'])
    if (code !== 0 || !existsSync(APK_PROD_SRC)) { say(`[nightly-run] production APK build ${code === 0 ? 'succeeded but output not found' : 'failed'}`); return false }
    copyFileSync(APK_PROD_SRC, APK_PROD_DEST)
    const { size } = statSync(APK_PROD_DEST)
    const version = readVersion()
    const manifest = readManifest()
    manifest.prod = {
      builtAt: new Date().toISOString(), sizeBytes: size, versionName: version.version ?? null, versionCode: version.versionCode ?? null,
      gitCommit: gitHead(), gitBranch: gitOut(['branch', '--show-current']),
      channel: 'prod', reportsToFirebase: true, licenseApi: 'prod', filename: 'playwork-prod-latest.apk',
    }
    writeManifest(manifest)
    say(`[nightly-run] production APK copied to ${APK_PROD_DEST} (${mb(size)} MB)`)
    return true
  },
}

// Debug APK of the newest tag, built in a separate git worktree so the working tree, branch, index and stash stay untouched.
const latestTag = () => gitOut(['for-each-ref', '--sort=-creatordate', '--count=1', '--format=%(refname:short)', 'refs/tags'])
const gitState = () => JSON.stringify({ head: gitOut(['rev-parse', 'HEAD']), branch: gitOut(['branch', '--show-current']), status: gitOut(['status', '--porcelain']), stash: gitOut(['stash', 'list']) })
function dropWorktree() {
  spawnSync('git', ['worktree', 'remove', '--force', MASTER_DIR], { cwd: ROOT })
  rmSync(MASTER_DIR, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT })
}
const masterBuild = {
  heading: 'latest release build (debug APK of the newest tag)', label: 'latest release', timeoutMs: 60 * MIN, idleMs: 15 * MIN,
  skipReason() {
    const tag = latestTag()
    const commit = tag ? gitOut(['rev-list', '-n', '1', tag]) : null
    if (!commit) return 'no release tag here'
    if (!process.env.BUILD_FORCE && readManifest().master?.commit === commit && existsSync(APK_MASTER_DEST)) return `an APK from master ${commit.slice(0, 7)} already exists`
    return null
  },
  async run() {
    const tag = latestTag()
    const commit = gitOut(['rev-list', '-n', '1', tag])
    const before = gitState()
    let ok = false
    try {
      progress(2, 'preparing worktree')
      dropWorktree()   // a leftover from an interrupted run
      if (spawnSync('git', ['worktree', 'add', '--detach', MASTER_DIR, commit], { cwd: ROOT }).status !== 0) throw new Error('git worktree add failed')
      // App source is the tag's; the Android build SCRIPT is the current one (the tag's copy cannot scaffold android/ for Capacitor 8).
      cpSync(resolve(ROOT, 'tools', 'build'), resolve(MASTER_DIR, 'tools', 'build'), { recursive: true })
      progress(6, 'npm ci')
      // Own install: the build script runs `npm install`, which must not rewrite this tree's node_modules.
      if ((await sh('npm', ['ci', '--silent'], { cwd: MASTER_DIR })) !== 0) throw new Error('npm ci failed in the master worktree')
      const code = await sh(`"${GIT_BASH}"`, ['tools/build/build-android.sh', '--no-install'], { cwd: MASTER_DIR, env: childRange(12, 98) })
      const apk = resolve(MASTER_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
      if (code !== 0 || !existsSync(apk)) throw new Error(`master APK build ${code === 0 ? 'produced no APK' : 'failed'}`)
      copyFileSync(apk, APK_MASTER_DEST)
      progress(100, 'published')
      const version = (() => { try { return JSON.parse(spawnSync('git', ['show', `${commit}:version.json`], { cwd: ROOT, encoding: 'utf8' }).stdout) } catch { return {} } })()
      const manifest = readManifest()
      manifest.master = {
        builtAt: new Date().toISOString(), commit, shortCommit: commit.slice(0, 7), tag,
        subject: gitOut(['log', '-1', '--format=%s', commit]), committedAt: gitOut(['log', '-1', '--format=%cI', commit]),
        sizeBytes: statSync(APK_MASTER_DEST).size, versionName: version.version ?? null, versionCode: version.versionCode ?? null,
        channel: 'dev', licenseApi: 'stage', filename: 'playwork-master-latest.apk',
      }
      writeManifest(manifest)
      ok = true
      say(`[nightly-run] master APK (${commit.slice(0, 7)}) published to ${APK_MASTER_DEST}`)
    } catch (err) {
      say(`[nightly-run] master build failed: ${err.message}`)
    } finally {
      dropWorktree()
      say(gitState() === before ? '[nightly-run] git state is exactly as before the master build (branch, HEAD, changes, stash)' : '[nightly-run] WARNING: the git state differs after the master build; check `git status`')
    }
    return ok
  },
}

// Runs BEFORE every build: the app bundles docs/manual, so the translated text must exist when the build starts.
// Not needed when Ollama is down (it catches up next time) or when no English text changed.
const manualTranslation = {
  heading: 'manual translation (Ollama)', label: 'manual translation', timeoutMs: 120 * MIN, idleMs: 20 * MIN,
  async skipReason() {
    if ((await sh('node', ['tools/i18n/manual-translate.mjs', 'status'], { quiet: true })) !== 0) return 'Ollama is not reachable or the translation model is missing (it catches up next time)'
    if ((await sh('node', ['tools/i18n/manual-translate.mjs', 'sync', '--lang', 'all', '--check'], { quiet: true })) === 0) return 'nothing to translate: the English manual has not changed'
    return null
  },
  run: async () => (await sh('node', ['tools/i18n/manual-translate.mjs', 'sync', '--lang', 'all', '--save', '--prune'])) === 0,
}

export const JOBS = {
  'manual-translation': manualTranslation,
  'web-build': command('web dev build (Chrome)', 'web build', ['tools/build/build-web-dev.mjs'], 20 * MIN, 8 * MIN),
  unit: command('unit tests', 'unit tests', ['tools/spec/record-test-run.mjs', 'unit'], 30 * MIN, 10 * MIN),
  e2e: command('e2e tests', 'e2e tests', ['tools/spec/record-test-run.mjs', 'e2e'], 60 * MIN, 15 * MIN),
  screenshots: command('screenshots tests', 'screenshots tests', ['tools/spec/record-test-run.mjs', 'screenshots'], 90 * MIN, 20 * MIN),
  'apk-debug': apkDebug,
  'apk-prod': apkProd,
  'master-build': masterBuild,
}
