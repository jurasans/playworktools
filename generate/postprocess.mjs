#!/usr/bin/env node
/**
 * Bulk post-processing for generated art. Operates on every image in a
 * folder — designed to run right after generate.mjs's batch, but works on
 * any folder of PNGs/JPEGs/WebPs.
 *
 * Two modes, chosen with --remove-bg / --no-remove-bg:
 *
 * - --remove-bg (default): background removal (real alpha transparency —
 *   SDXL can't emit this itself; "white background" in a prompt is just
 *   white pixels, not transparency — via @imgly/background-removal-node,
 *   ONNX-based, local/offline, no GPU needed) → trim the transparent margin
 *   → resize to fit inside (size − padding) → pad onto an exact size×size
 *   transparent canvas, so every icon shares the same framing. Built for
 *   isolated-icon use cases (e.g. flashcard-style art on its own background).
 *
 * - --no-remove-bg: just resize to fit within size×size (aspect ratio
 *   preserved, no forced square canvas, no trim, original background kept
 *   intact) → re-encode. Built for full-scene art where the generated
 *   background is meant to stay (e.g. Memory Cards Match's card
 *   illustrations — verified: 1024px source down to 320px, still 3x
 *   oversampled for retina at the game's 96px max on-screen card size,
 *   zero visible quality loss, ~92% smaller).
 *
 * Either mode re-encodes to a space-efficient format — WebP defaults to
 * lossless (flat color regions + hard edges show visible banding/ringing
 * under lossy compression); pass --quality for a smaller lossy encode if
 * size matters more than pixel-perfect edges.
 *
 * Usage:
 *   node postprocess.mjs --in data/output --out data/processed
 *   node postprocess.mjs --in data/output --out data/processed --no-remove-bg --size 320
 *   node postprocess.mjs --in data/output --out data/processed --size 256 --quality 90
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { removeBackground } from '@imgly/background-removal-node'
import { wireFile, describeWireResult } from './lib/wireOutput.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  in:        path.join(__dirname, 'data', 'output'),
  out:       path.join(__dirname, 'data', 'processed'),
  removeBg:  true,
  trim:      true,       // only applies when removeBg is true
  size:      512,        // no-remove-bg mode: max dimension. remove-bg mode: final square canvas.
  padPct:    0.06,        // remove-bg mode only: empty margin around the trimmed subject, as a fraction of --size
  fit:       'inside',    // sharp resize fit mode
  quality:   null,        // null = lossless WebP; 1-100 = lossy WebP at that quality
  format:    'webp',
  wireTo:    null,        // e.g. ../../public/images/othertests — first result per key goes straight there
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case '--help': case '-h': printHelp(); process.exit(0); break
      case '--in':            args.in = path.resolve(next()); break
      case '--out':           args.out = path.resolve(next()); break
      case '--remove-bg':     args.removeBg = true; break
      case '--no-remove-bg':  args.removeBg = false; break
      case '--trim':          args.trim = true; break
      case '--no-trim':       args.trim = false; break
      case '--size':          args.size = parseInt(next(), 10); break
      case '--pad-pct':       args.padPct = parseFloat(next()); break
      case '--fit':           args.fit = next(); break
      case '--quality':       args.quality = parseInt(next(), 10); break
      case '--format':        args.format = next(); break
      case '--wire-to':       args.wireTo = path.resolve(next()); break
      default:
        console.warn(`[postprocess] unrecognized argument: ${a}`)
    }
  }
  return args
}

function printHelp() {
  console.log(`
Usage: node postprocess.mjs [options]

Options:
  --in <dir>          Folder of source images to process (default: data/output)
  --out <dir>         Folder to write processed images to (default: data/processed)
  --remove-bg         Remove background + trim + pad to a square canvas (default)
  --no-remove-bg      Skip background removal entirely — just resize + re-encode,
                      keeping the original background intact (no trim, no padding)
  --trim              Trim the transparent margin after background removal (default,
                      ignored with --no-remove-bg)
  --no-trim           Skip trimming even in --remove-bg mode
  --size <N>          --remove-bg mode: final square canvas size in px (default: ${DEFAULTS.size})
                      --no-remove-bg mode: max width/height, aspect ratio preserved
  --pad-pct <N>       --remove-bg mode only: empty margin around the trimmed subject,
                      as a fraction of --size (default: ${DEFAULTS.padPct})
  --fit <mode>        sharp resize fit mode: inside/cover/contain/fill/outside (default: ${DEFAULTS.fit})
  --quality <N>       Lossy WebP quality 1-100 (default: lossless WebP)
  --format <ext>      Output format: webp or png (default: ${DEFAULTS.format})
  --wire-to <dir>     App-live folder for this asset (e.g. ../../public/images/othertests). The FIRST
                      processed result for a given filename is written straight there — no review step
                      needed. Every result after that for the same filename (it already exists at
                      --wire-to) is instead saved under data/versions/<name>/v2.<ext>, v3.<ext>, ... and
                      the live file is left untouched.

Examples:
  node postprocess.mjs --in data/output --out data/processed
  node postprocess.mjs --in data/output --out data/processed --no-remove-bg --size 320
  node postprocess.mjs --in data/output --out data/processed --wire-to ../../public/images/othertests
`)
}

async function processOne(srcPath, args) {
  if (!args.removeBg) {
    // Just resize + re-encode — original background stays, no trim, no padding.
    const resized = sharp(srcPath).resize(args.size, args.size, { fit: args.fit, withoutEnlargement: false })
    return args.format === 'png'
      ? resized.png({ compressionLevel: 9 }).toBuffer()
      : args.quality
        ? resized.webp({ quality: args.quality }).toBuffer()
        : resized.webp({ lossless: true }).toBuffer()
  }

  // 1. Background removal — real alpha transparency, not just white pixels.
  // Must pass an explicit Blob, not a path string or a raw Buffer:
  // - A path string like "B:\foo\bar.png" gets misparsed as a URL with a
  //   "b:" protocol scheme on Windows ("Unsupported protocol: b:").
  // - A raw Node Buffer (though technically a Uint8Array) fails the
  //   library's internal format sniffing ("Unsupported format:").
  // Wrapping the bytes in a real Blob with an explicit mime type is the one
  // input shape that actually works (verified directly against this package).
  const inputBlob = new Blob([fs.readFileSync(srcPath)], { type: 'image/png' })
  const blob = await removeBackground(inputBlob)
  let working = Buffer.from(await blob.arrayBuffer())

  // 2. Trim the transparent margin the cutout leaves around the subject.
  if (args.trim) working = await sharp(working).trim().toBuffer()

  // 3. Resize to fit within (size - padding), preserving aspect ratio, then
  //    pad to an exact square canvas so every icon shares the same framing.
  const innerSize = Math.round(args.size * (1 - args.padPct * 2))
  const resized = await sharp(working)
    .resize(innerSize, innerSize, { fit: args.fit, withoutEnlargement: false })
    .toBuffer()

  const padded = sharp({
    create: { width: args.size, height: args.size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: resized, gravity: 'center' }])

  // 4. Encode to a space-efficient format.
  if (args.format === 'png') {
    return padded.png({ compressionLevel: 9 }).toBuffer()
  }
  return args.quality
    ? padded.webp({ quality: args.quality }).toBuffer()
    : padded.webp({ lossless: true }).toBuffer()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(args.in)) {
    console.error(`Error: input folder does not exist: ${args.in}`)
    process.exit(1)
  }
  fs.mkdirSync(args.out, { recursive: true })

  const files = fs.readdirSync(args.in).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  if (files.length === 0) {
    console.error(`Error: no images found in ${args.in}`)
    process.exit(1)
  }

  const modeDesc = args.removeBg
    ? `${args.size}x${args.size} square, bg-removed${args.trim ? '+trimmed' : ''}`
    : `max ${args.size}px, background kept`
  console.log(`[postprocess] ${files.length} image(s) -> ${path.relative(process.cwd(), args.out)} (${modeDesc}, ${args.format}${args.quality ? ` q${args.quality}` : ' lossless'})`)

  let totalBefore = 0
  let totalAfter = 0

  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const srcPath = path.join(args.in, file)
    const baseName = path.parse(file).name
    const destPath = path.join(args.out, `${baseName}.${args.format}`)

    const beforeSize = fs.statSync(srcPath).size
    process.stdout.write(`[postprocess] (${i + 1}/${files.length}) ${file} ... `)

    try {
      const outBuffer = await processOne(srcPath, args)
      fs.writeFileSync(destPath, outBuffer)
      const afterSize = outBuffer.length
      totalBefore += beforeSize
      totalAfter += afterSize
      const pct = ((1 - afterSize / beforeSize) * 100).toFixed(0)
      console.log(`${(beforeSize / 1024).toFixed(0)}KB -> ${(afterSize / 1024).toFixed(0)}KB (-${pct}%)`)

      if (args.wireTo) {
        const result = wireFile(outBuffer, args.wireTo, `${baseName}.${args.format}`)
        console.log(`[postprocess]   ${describeWireResult(result)}`)
      }
    } catch (err) {
      console.log(`FAILED: ${err.message}`)
    }
  }

  const totalPct = totalBefore ? ((1 - totalAfter / totalBefore) * 100).toFixed(0) : 0
  console.log(`\n[postprocess] Done — ${(totalBefore / 1024 / 1024).toFixed(1)}MB -> ${(totalAfter / 1024 / 1024).toFixed(1)}MB (-${totalPct}% total)`)
}

main().catch((err) => {
  console.error('\n[postprocess] FAILED:', err.message)
  process.exit(1)
})
