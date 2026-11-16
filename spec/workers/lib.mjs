// Shared bits of the nightly workers: paths, the per-worker status file, git helpers and the "already built" check.
// A worker is one stage of the nightly (tools/spec/workers/worker.mjs <name>); it reports itself in state/workers/<name>.json
// so the orchestrator (nightly-run.mjs), spec-web and a person running it by hand all read the same status.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
export const DATA_DIR = resolve(ROOT, 'tools', 'spec-web', 'documentation', 'state')
export const DOWNLOADS_DIR = resolve(DATA_DIR, 'downloads')
export const MANIFEST = resolve(DOWNLOADS_DIR, 'manifest.json')
export const WORKERS_DIR = resolve(DATA_DIR, 'workers')
export const MIN = 60_000

// Exit codes a worker uses: the orchestrator maps them to done / failed / skipped.
export const EXIT = { PASS: 0, FAIL: 1, SKIPPED: 3 }

export const gitOut = (args) => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }

export function readManifest() { try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return {} } }
export function writeManifest(m) { mkdirSync(DOWNLOADS_DIR, { recursive: true }); writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + '\n') }
export function readVersion() { try { return JSON.parse(readFileSync(resolve(ROOT, 'version.json'), 'utf8')) } catch { return {} } }

const statusPath = (name) => resolve(WORKERS_DIR, `${name}.json`)
export function readStatus(name) { try { return JSON.parse(readFileSync(statusPath(name), 'utf8')) } catch { return null } }
// Written through a temp file: the orchestrator polls this while the worker updates it.
export function writeStatus(name, patch) {
  mkdirSync(WORKERS_DIR, { recursive: true })
  const next = { ...(readStatus(name) || {}), ...patch, updatedAt: new Date().toISOString() }
  const tmp = `${statusPath(name)}.${process.pid}.tmp`
  try { writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n'); renameSync(tmp, statusPath(name)) } catch { /* a locked file must not fail a build */ }
  return next
}

// Auto-skip: an APK is not rebuilt when the manifest says it was built from this very commit and nothing that goes into the
// app has changed since. BUILD_FORCE (the Rebuild button) always builds. Returns the reason to skip, or null.
const APP_PATHS = ['src', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tools/build', 'version.json']
export function builtAlready(entryKey, apkPath) {
  if (process.env.BUILD_FORCE || !existsSync(apkPath)) return null
  const m = readManifest()
  const entry = entryKey ? m[entryKey] : m
  const head = gitOut(['rev-parse', '--short', 'HEAD'])
  if (!entry?.gitCommit || entry.gitCommit !== head) return null
  if (gitOut(['status', '--porcelain', '--', ...APP_PATHS])) return null
  return `already built from ${head} and nothing in the app changed since`
}
