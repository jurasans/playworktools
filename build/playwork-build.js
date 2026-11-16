#!/usr/bin/env node
/**
 * Playwork Android Build CLI
 * ─────────────────────────────────────────────────────────────────
 * Interactive tool to bump the version, pick a build type, then
 * compile both APK and AAB (Android App Bundle) for Google Play.
 *
 * Usage:  node playwork-build.js
 *         npm run build:android
 */

import { createInterface }        from 'readline/promises'
import { spawn }                  from 'child_process'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname, join } from 'path'
import { fileURLToPath }          from 'url'
import { progress }                from './progress.mjs'

// ── Paths ──────────────────────────────────────────────────────────────────────
const __dirname    = dirname(fileURLToPath(import.meta.url))
const ROOT         = resolve(__dirname, '..', '..')   // project root (two levels up from tools/build/)
const VERSION_FILE = join(ROOT, 'version.json')
const GRADLE_FILE  = join(ROOT, 'android', 'app', 'build.gradle')
const ANDROID_DIR  = join(ROOT, 'android')
const KEYSTORE_PROPS = join(ROOT, 'android', 'keystore.properties')

// ── ANSI colours ──────────────────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  magenta:'\x1b[35m',
  white:  '\x1b[97m',
}

const b  = (s) => `${c.bold}${s}${c.reset}`
const g  = (s) => `${c.green}${s}${c.reset}`
const cy = (s) => `${c.cyan}${s}${c.reset}`
const y  = (s) => `${c.yellow}${s}${c.reset}`
const r  = (s) => `${c.red}${s}${c.reset}`
const d  = (s) => `${c.dim}${s}${c.reset}`

// ── Helpers ───────────────────────────────────────────────────────────────────

function readVersion() {
  return JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
}

function writeVersion(v) {
  writeFileSync(VERSION_FILE, JSON.stringify(v, null, 2) + '\n')
  // Patch build.gradle versionCode + versionName in-place
  let gradle = readFileSync(GRADLE_FILE, 'utf8')
  gradle = gradle.replace(/(versionCode\s+)\d+/,      `$1${v.versionCode}`)
  gradle = gradle.replace(/(versionName\s+)"[^"]*"/, `$1"${v.version}"`)
  writeFileSync(GRADLE_FILE, gradle)
}

function bumpVersion(current, type) {
  const [maj, min, pat] = current.split('.').map(Number)
  switch (type) {
    case 'major': return `${maj + 1}.0.0`
    case 'minor': return `${maj}.${min + 1}.0`
    case 'patch': return `${maj}.${min}.${pat + 1}`
    default:      return current
  }
}

// ── Java home detection ───────────────────────────────────────────────────────
// Always override the system JAVA_HOME — it may point to Unity, IntelliJ,
// or another JDK that isn't compatible with the Android Gradle plugin.
// Priority: PLAYWORK_JAVA_HOME env var → first valid Android Studio JBR found.
const ANDROID_STUDIO_JBR_CANDIDATES = [
  'C:\\Program Files\\Android\\Android Studio\\jbr',
  'C:\\Program Files\\Android\\Android Studio1\\jbr',
  'C:\\Program Files\\Android\\Android Studio2\\jbr',
  'C:\\Program Files\\Android\\Android Studio Preview\\jbr',
]

function resolveJavaHome() {
  // Explicit override always wins
  if (process.env.PLAYWORK_JAVA_HOME) return process.env.PLAYWORK_JAVA_HOME
  // Auto-detect first valid Android Studio JBR
  for (const p of ANDROID_STUDIO_JBR_CANDIDATES) {
    if (existsSync(join(p, 'bin', 'java.exe'))) return p
    if (existsSync(join(p, 'bin', 'java')))     return p   // macOS / Linux
  }
  // Last resort: whatever the system has (may fail if it's Unity / wrong JDK)
  console.log(y('\n  ⚠  Could not find Android Studio JBR — falling back to system JAVA_HOME.'))
  console.log(y('     Set PLAYWORK_JAVA_HOME in your environment to point to the correct JDK.\n'))
  return process.env.JAVA_HOME ?? ''
}

/** Run a shell command, streaming stdout/stderr to the terminal. extraEnv merges into the child's env (e.g. VITE_BUILD_CHANNEL for the web build step). */
function run(cmd, cwd = ROOT, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    console.log(d(`\n  $ ${cmd}\n`))
    const env = {
      ...process.env,
      JAVA_HOME: resolveJavaHome(),   // always override — never inherit Unity / wrong JDK
      ...extraEnv,
    }
    const proc = spawn(cmd, { shell: true, stdio: 'inherit', cwd, env })
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`Exit ${code}: ${cmd}`))
    )
  })
}

/** Ask a numbered-choice question; returns the chosen key. */
async function choose(rl, question, options) {
  // options: [ { key, label } ]
  console.log(`\n  ${b(question)}`)
  options.forEach(({ key, label }, i) =>
    console.log(`    ${cy(`${i + 1})`)} ${label}  ${d(`[${key}]`)}`)
  )
  while (true) {
    const raw = (await rl.question(`\n  ${c.cyan}→${c.reset} `)).trim()
    const idx = parseInt(raw, 10) - 1
    if (idx >= 0 && idx < options.length) return options[idx].key
    const exact = options.find(o => o.key === raw)
    if (exact) return exact.key
    console.log(r(`  Invalid — enter a number 1–${options.length}`))
  }
}

// ── CLI argument parsing ───────────────────────────────────────────────────────
// Usage: npm run build:android -- [--keep] [--debug|--release|--both|--nightly] [--stage|--prod] [--run] [--verified]
//   --nightly   release APK only, production channel (reports to Firebase) and prod license API, with the version and
//               versionCode left exactly as they are (the nightly job must not bump them every night)
//   --keep      keep current version (skip version-bump prompt)
//   --debug     build debug APK (skip build-type prompt)
//   --release   build release APK+AAB (skip build-type prompt)
//   --both      build both (skip build-type prompt)
//   --stage     force the staging license API (default for --debug)
//   --prod      force the prod license API (default for --release / --both)
//   --run       after building, adb install + launch on first connected device
//   --yes / -y  auto-confirm the summary prompt
//   --verified  gate the web build on `tsc -b && vitest run` before `vite build`
//               (runs `npm run build:verified` instead of the plain `npm run build`)
//               — opt-in since a device deploy is exactly the kind of build worth
//               gating, but the flag stays off by default so routine local
//               `--run` iterations aren't slowed down by it.

const ARGS = process.argv.slice(2)
const FLAG = {
  keep:     ARGS.includes('--keep'),
  debug:    ARGS.includes('--debug'),
  release:  ARGS.includes('--release'),
  both:     ARGS.includes('--both'),
  run:      ARGS.includes('--run'),
  yes:      ARGS.includes('--yes') || ARGS.includes('-y'),
  verified: ARGS.includes('--verified'),
  nightly:  ARGS.includes('--nightly'),
  stage:    ARGS.includes('--stage'),
  prod:     ARGS.includes('--prod'),
}
if (FLAG.stage && FLAG.prod) { console.error('Use only one of --stage / --prod'); process.exit(1) }
if (FLAG.nightly) FLAG.release = true
// Any build-type flag implies --keep and --yes (fully non-interactive)
if (FLAG.debug || FLAG.release || FLAG.both) { FLAG.keep = true; FLAG.yes = true }
if (FLAG.keep) FLAG.yes = true

// ── Preflight checks ──────────────────────────────────────────────────────────

function checkKeystore() {
  if (!existsSync(KEYSTORE_PROPS)) {
    console.log(r('\n  ✗ android/keystore.properties not found.'))
    console.log(y('    Create it with storePassword / keyPassword filled in.'))
    process.exit(1)
  }
  const props = readFileSync(KEYSTORE_PROPS, 'utf8')
  if (props.includes('FILL_IN')) {
    console.log(r('\n  ✗ android/keystore.properties still has placeholder passwords.'))
    console.log(y('    Edit android/keystore.properties and set the real passwords.'))
    process.exit(1)
  }
}

// ── Output paths ──────────────────────────────────────────────────────────────

function outputPaths(buildType) {
  const t = buildType === 'release' ? 'release' : 'debug'
  const suffix = buildType === 'release' ? 'release' : 'debug'
  return {
    apk: join(ROOT, `android/app/build/outputs/apk/${t}/app-${suffix}.apk`),
    aab: join(ROOT, `android/app/build/outputs/bundle/${t}/app-${suffix}.aab`),
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${c.bold}${c.magenta}  ╔══════════════════════════════════╗`)
  console.log(`  ║   Playwork  Android  Build CLI   ║`)
  console.log(`  ╚══════════════════════════════════╝${c.reset}\n`)

  // ── Check keystore ─────────────────────────────────────────────
  checkKeystore()

  const rl   = createInterface({ input: process.stdin, output: process.stdout })
  const ver  = readVersion()

  console.log(`  Current version: ${b(ver.version)}  ${d(`(versionCode ${ver.versionCode})`)}`)

  // ── 1. Version bump ────────────────────────────────────────────
  const bumpType = FLAG.keep
    ? 'none'
    : await choose(rl, 'Version bump?', [
        { key: 'none',  label: `Keep  ${d(ver.version)}` },
        { key: 'patch', label: `Patch ${d(bumpVersion(ver.version, 'patch'))}  — bug fixes` },
        { key: 'minor', label: `Minor ${d(bumpVersion(ver.version, 'minor'))}  — new features` },
        { key: 'major', label: `Major ${d(bumpVersion(ver.version, 'major'))}  — breaking / major release` },
      ])

  // ── 2. Build type ──────────────────────────────────────────────
  const buildType = FLAG.debug   ? 'debug'
                  : FLAG.release ? 'release'
                  : FLAG.both    ? 'both'
                  : await choose(rl, 'Build type?', [
                      { key: 'debug',   label: 'Debug    — fast build, keystore-signed, for sideload / Play internal' },
                      { key: 'release', label: 'Release  — optimised, keystore-signed, for Play production / review' },
                      { key: 'both',    label: 'Both     — debug + release' },
                    ])

  // Reported: a dev/debug build must never report analytics/crashes/logs to
  // Firebase and must never bump the Android version — only a real production
  // build shipped through this interactive CLI should do either. A pure
  // 'debug' session is the dev path: version.json/build.gradle are left
  // exactly as they are (no bump at all, not even the "keep current version"
  // no-op rewrite), and the web build below gets VITE_BUILD_CHANNEL='dev' —
  // src/utils/buildChannel.ts's isProductionBuild() (which gates
  // isFirebaseConfigured() for both analytics and crashlytics) only ever
  // returns true when this is explicitly 'prod'. 'release' and 'both' both
  // produce a genuine release artifact, so both bump the version and build
  // with the 'prod' channel — including the debug APK built alongside a
  // 'both' session, since only one shared web bundle is built either way.
  const isDebugOnly = buildType === 'debug'
  const channel = isDebugOnly ? 'dev' : 'prod'
  // A nightly production APK is a real prod-channel build but must not consume a versionCode every night.
  const noBump = isDebugOnly || FLAG.nightly

  const newVersion     = noBump ? ver.version     : (bumpType === 'none' ? ver.version : bumpVersion(ver.version, bumpType))
  const newVersionCode = noBump ? ver.versionCode : ver.versionCode + 1

  // ── 3. Confirm ─────────────────────────────────────────────────
  console.log(`\n  ${b('Summary')}`)
  console.log(noBump
    ? `    Version     : ${g(newVersion)}  ${d(FLAG.nightly ? '(unchanged — nightly builds never bump the version)' : '(unchanged — debug builds never bump the version)')}`
    : `    Version     : ${g(newVersion)}  ${d(`→ versionCode ${newVersionCode}`)}`)
  console.log(`    Build type  : ${cy(buildType)}`)
  console.log(`    Reporting   : ${isDebugOnly ? d('disabled (dev build)') : g('enabled (production build)')}`)
  // Which backend the app talks to: follows the channel unless --stage / --prod says otherwise.
  const licenseEnv = FLAG.prod ? 'prod' : FLAG.stage ? 'stage' : (channel === 'prod' ? 'prod' : 'stage')
  console.log(`    License API : ${licenseEnv === 'prod' ? y('PROD (api.goplaywork.com)') : g('staging (dev-api.goplaywork.com)')}${FLAG.prod || FLAG.stage ? d('  (forced by flag)') : ''}`)
  console.log(`    Package     : ${d('com.Playwork.Playwork')}`)

  if (!FLAG.yes) {
    const go = (await rl.question(`\n  ${b('Proceed?')}  ${d('[y/N]')}  `)).trim().toLowerCase()
    if (go !== 'y' && go !== 'yes') {
      console.log(y('\n  Aborted.\n'))
      rl.close(); process.exit(0)
    }
  } else {
    console.log(d('\n  (auto-confirmed via --yes / build-type flag)'))
  }
  rl.close()

  progress(3, 'starting')
  // ── 4. Write updated version ───────────────────────────────────
  // Skipped entirely for a pure debug build — not just left at the same
  // value, genuinely untouched, so version.json/build.gradle keep whatever
  // versionCode the last real (release/both) build left them at.
  if (noBump) {
    console.log(d(`\n  – version.json left unchanged (${FLAG.nightly ? 'nightly' : 'debug'} build)`))
  } else {
    writeVersion({ version: newVersion, versionCode: newVersionCode })
    console.log(g(`\n  ✓ version.json updated  →  ${newVersion}  (versionCode ${newVersionCode})`))
  }

  // ── 5. Web build ───────────────────────────────────────────────
  // VITE_BUILD_CHANNEL flows into the web bundle as import.meta.env.VITE_BUILD_CHANNEL
  // (any VITE_-prefixed env var Vite sees is exposed automatically — no vite.config.ts
  // change needed) — see src/utils/buildChannel.ts for how this gates Firebase reporting.
  console.log(cy('\n  ── Web build ─────────────────────────────────────'))
  progress(8, 'web build')
  // licenseEnv (chosen in the summary above) follows the channel unless --stage / --prod forces it. iOS/TestFlight is
  // separate (see fastlane/Fastfile).
  console.log(d(`  (VITE_BUILD_CHANNEL=${channel}, VITE_LICENSE_ENV=${licenseEnv})`))
  await run(FLAG.verified ? 'npm run build:verified' : 'npm run build', ROOT, { VITE_BUILD_CHANNEL: channel, VITE_LICENSE_ENV: licenseEnv })

  // ── 6. Capacitor sync ──────────────────────────────────────────
  progress(40, 'capacitor sync')
  console.log(cy('\n  ── Capacitor sync ────────────────────────────────'))
  await run('npx cap sync android')

  // ── 7. Gradle build(s) ─────────────────────────────────────────
  const targets = buildType === 'both'
    ? ['debug', 'release']
    : [buildType]

  for (const [i, t] of targets.entries()) {
    const from = 44 + (i * 54) / targets.length, to = 44 + ((i + 1) * 54) / targets.length
    progress(from, `gradle ${t} starting`)
    const gradleTask = t === 'release'
      ? (FLAG.nightly ? 'assembleRelease' : 'assembleRelease bundleRelease')
      : 'assembleDebug   bundleDebug'

    console.log(cy(`\n  ── Gradle ${t} ──────────────────────────────────`))
    // Through the task counter: it prints [progress] lines and, as a pipe hides gradle's exit code on cmd, fails unless BUILD SUCCESSFUL.
    await run(`.\\gradlew.bat ${gradleTask} 2>&1 | node "${join(__dirname, 'gradle-progress.mjs')}" ${t} ${Math.round(from)} ${Math.round(to)}`, ANDROID_DIR)

    const paths = outputPaths(t)
    console.log(g(`\n  ✓ ${t.toUpperCase()} build complete`))
    console.log(`    APK : ${b(paths.apk)}`)
    if (!FLAG.nightly) console.log(`    AAB : ${b(paths.aab)}`)
  }

  // ── 8. Install + launch (--run) ───────────────────────────────
  if (FLAG.run) {
    const apkPath = outputPaths(buildType === 'both' ? 'debug' : buildType).apk
    const ADB = `"${process.env.LOCALAPPDATA}\\Android\\Sdk\\platform-tools\\adb.exe"`
    console.log(cy('\n  ── Install + launch ──────────────────────────────'))
    await run(`${ADB} install -r "${apkPath}"`)
    await run(`${ADB} shell monkey -p com.Playwork.Playwork -c android.intent.category.LAUNCHER 1`)
    console.log(g('\n  ✓ Installed and launched on device'))
  }

  progress(100, 'done')
  console.log(`\n${c.green}${c.bold}  ✓ All done — Playwork ${newVersion} (${newVersionCode})${c.reset}\n`)
}

main().catch((err) => {
  console.error(r(`\n  ✗ Build failed: ${err.message}\n`))
  process.exit(1)
})
