#!/usr/bin/env node
/**
 * tagged-build.mjs — builds a signed production-channel APK of an old git tag in a throwaway worktree and publishes it
 * to the spec-web Downloads tab under a custom name (manifest.<key>, served at /api/build/download?variant=<key>).
 *
 * Usage: node tools/spec/tagged-build.mjs --tag v2.1.0 --key chinese --title "THE CHINESE BUILD"
 *
 * The working tree, branch, index and stash are never touched; the worktree is removed afterwards.
 * Production channel = reports to Firebase and uses the prod license API; version/versionCode stay as the tag has them.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { progress, childRange } from '../build/progress.mjs'
import { GIT_BASH } from '../build/find-bash.mjs'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : null }
const TAG = arg('tag'), KEY = arg('key'), TITLE = arg('title') ?? KEY
if (!TAG || !KEY || !/^[a-z0-9-]+$/.test(KEY)) { console.error('need --tag <tag> --key <slug> [--title "Name"]'); process.exit(1) }

const DOWNLOADS = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', 'downloads')
const MANIFEST = resolve(DOWNLOADS, 'manifest.json')
const WT = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state', `tagged-build-${KEY}`)
const DEST = resolve(DOWNLOADS, `playwork-${KEY}-latest.apk`)

const git = (a, cwd = ROOT) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }
const run = (cmd, args, cwd, env) => new Promise((res) => {
  const c = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })
  c.on('close', (code) => res(code ?? 1))
})
const dropWorktree = () => {
  spawnSync('git', ['worktree', 'remove', '--force', WT], { cwd: ROOT })
  rmSync(WT, { recursive: true, force: true })
  spawnSync('git', ['worktree', 'prune'], { cwd: ROOT })
}

const commit = git(['rev-list', '-n', '1', TAG])
if (!commit) { console.error(`tag ${TAG} not found`); process.exit(1) }
const keystoreProps = resolve(ROOT, 'android', 'keystore.properties')
const keystore = resolve(ROOT, 'android', 'app', 'user.keystore')
if (!existsSync(keystoreProps) || !existsSync(keystore)) { console.error('android/keystore.properties or android/app/user.keystore missing'); process.exit(1) }

const before = JSON.stringify([git(['rev-parse', 'HEAD']), git(['branch', '--show-current']), git(['status', '--porcelain']), git(['stash', 'list'])])
let ok = false
try {
  progress(2, 'preparing worktree')
  dropWorktree()
  if (spawnSync('git', ['worktree', 'add', '--detach', WT, commit], { cwd: ROOT }).status !== 0) throw new Error('git worktree add failed')
  // Tooling from the current tree: the tag's own build script cannot scaffold android/ for Capacitor 8 (Java 17 vs 21).
  cpSync(resolve(ROOT, 'tools', 'build'), resolve(WT, 'tools', 'build'), { recursive: true })
  // tools/ is git-ignored, so a tag has none of it; its tests (tsc -b) import tools/i18n/csv-merge.mjs.
  cpSync(resolve(ROOT, 'tools', 'i18n'), resolve(WT, 'tools', 'i18n'), { recursive: true })
  progress(5, 'npm ci')
  if ((await run('npm', ['ci', '--silent'], WT)) !== 0) throw new Error('npm ci failed')
  // Scaffold android/ and inject the signing config (dev build, discarded), then build the real prod release over it.
  progress(10, 'setting up the android project')
  if ((await run(GIT_BASH, ['tools/build/build-android.sh', '--no-install'], WT, childRange(10, 45))) !== 0) throw new Error('android scaffold build failed')
  copyFileSync(keystoreProps, resolve(WT, 'android', 'keystore.properties'))
  copyFileSync(keystore, resolve(WT, 'android', 'app', 'user.keystore'))
  progress(45, 'production build')
  if ((await run('node', ['tools/build/playwork-build.js', '--nightly'], WT, childRange(45, 98))) !== 0) throw new Error('production build failed')
  const apk = resolve(WT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  if (!existsSync(apk)) throw new Error('no release APK produced')
  mkdirSync(DOWNLOADS, { recursive: true })
  copyFileSync(apk, DEST)
  let version = {}
  try { version = JSON.parse(readFileSync(resolve(WT, 'version.json'), 'utf8')) } catch { /* optional */ }
  let manifest = {}
  try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { /* none yet */ }
  manifest[KEY] = {
    title: TITLE, builtAt: new Date().toISOString(), tag: TAG, commit, shortCommit: commit.slice(0, 7),
    subject: git(['log', '-1', '--format=%s', commit]), sizeBytes: statSync(DEST).size,
    versionName: version.version ?? null, versionCode: version.versionCode ?? null,
    channel: 'prod', reportsToFirebase: true, licenseApi: 'prod', filename: `playwork-${KEY}-latest.apk`,
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  ok = true
  progress(100, 'published')
  console.log(`\n[tagged-build] ${TITLE} (${TAG} ${commit.slice(0, 7)}) published to ${DEST}`)
} catch (err) {
  console.error(`[tagged-build] failed: ${err.message}`)
} finally {
  dropWorktree()
  const after = JSON.stringify([git(['rev-parse', 'HEAD']), git(['branch', '--show-current']), git(['status', '--porcelain']), git(['stash', 'list'])])
  console.log(after === before ? '[tagged-build] git state unchanged' : '[tagged-build] WARNING: git state differs, check `git status`')
}
process.exit(ok ? 0 : 1)
