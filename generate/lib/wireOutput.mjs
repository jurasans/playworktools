/**
 * Wires a finished generation result (image or audio bytes) straight into the
 * app's live asset folder — the first time an asset with a given filename is
 * produced, no review/copy step needed. Every generation after that first one
 * is kept in a separate versioned folder instead of overwriting the live file,
 * so a regeneration never clobbers an asset that's already wired into the app
 * without an explicit, deliberate promotion.
 *
 * Policy:
 *   - destDir/filename does not exist yet  -> write there directly (v1, live).
 *   - destDir/filename already exists      -> write to
 *     data/versions/<baseName>/v2.<ext>, v3.<ext>, ... instead (never touches
 *     the live file). The version number is the next unused one found on disk,
 *     so it survives across separate script runs, not just within one batch.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IMAGE_GEN_DIR = path.resolve(__dirname, '..')
const VERSIONS_DIR = path.join(IMAGE_GEN_DIR, 'data', 'versions')

function nextVersionNumber(baseName) {
  const dir = path.join(VERSIONS_DIR, baseName)
  if (!fs.existsSync(dir)) return 2 // v1 is implicitly the live file already at destDir
  const existing = fs.readdirSync(dir)
    .map((f) => /^v(\d+)\./.exec(f))
    .filter(Boolean)
    .map((m) => parseInt(m[1], 10))
  return existing.length ? Math.max(...existing) + 1 : 2
}

/**
 * @param {Buffer} bytes       the generated file's raw bytes
 * @param {string} destDir     the app's live folder for this asset type (e.g. public/audio/sfx)
 * @param {string} filename    e.g. "pickup.mp3" / "hamstring.webp"
 * @returns {{ wired: boolean, path: string }} wired=true means this is now the live asset;
 *          wired=false means an existing live asset was left untouched and this is a new version.
 */
export function wireFile(bytes, destDir, filename) {
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, filename)

  if (!fs.existsSync(destPath)) {
    fs.writeFileSync(destPath, bytes)
    return { wired: true, path: destPath }
  }

  const ext = path.extname(filename)
  const baseName = path.parse(filename).name
  const n = nextVersionNumber(baseName)
  const versionDir = path.join(VERSIONS_DIR, baseName)
  fs.mkdirSync(versionDir, { recursive: true })
  const versionPath = path.join(versionDir, `v${n}${ext}`)
  fs.writeFileSync(versionPath, bytes)
  return { wired: false, path: versionPath }
}

/** Console-friendly one-liner for a wireFile() result. */
export function describeWireResult(result) {
  return result.wired
    ? `wired live -> ${path.relative(process.cwd(), result.path)}`
    : `live asset already exists — saved as a new version -> ${path.relative(process.cwd(), result.path)} (destination untouched)`
}
