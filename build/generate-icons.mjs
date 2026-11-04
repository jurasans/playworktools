/**
 * Generates Android + iOS app icons from the real Playwork brand asset
 * (assets/icon/playwork-icon-source.png — black bg, PLAYWORK wordmark + play
 * triangle, "Intelligent Physiotherapy Technology" subtitle). Replaces the old
 * procedurally-drawn SVG text approach, which clipped "WORK" at small sizes.
 *
 * iOS support added because the two platforms had silently drifted — Android
 * got this real asset, but `cap add ios` scaffolds its own generic Capacitor
 * placeholder icon (a plain colored "cap" mark) into AppIcon.appiconset and
 * nothing ever replaced it, so a real device install showed the wrong icon
 * entirely (reported live: "the icon of the app doesnt match the one on
 * android"). Both `android/` and `ios/` are gitignored/regenerated from
 * scratch by their respective `cap add` — this script is the one thing that
 * re-patches both after every fresh scaffold, same pattern as every other
 * idempotent injection in build-android.sh/build-ios.sh.
 *
 * Run: node tools/build/generate-icons.mjs
 * Requires: sharp (already in package.json)
 */

import sharp from 'sharp'
import fs    from 'fs'
import path  from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RES         = path.resolve(__dirname, '../../android/app/src/main/res')
const IOS_APPICON = path.resolve(__dirname, '../../ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png')
const SOURCE      = path.resolve(__dirname, '../../assets/icon/playwork-icon-source.png')

// ── Size tables ───────────────────────────────────────────────────────────────

const LAUNCHER_SIZES = {
  'mipmap-mdpi':    48,
  'mipmap-hdpi':    72,
  'mipmap-xhdpi':   96,
  'mipmap-xxhdpi':  144,
  'mipmap-xxxhdpi': 192,
}

const FOREGROUND_SIZES = {
  'mipmap-mdpi':    108,
  'mipmap-hdpi':    162,
  'mipmap-xhdpi':   216,
  'mipmap-xxhdpi':  324,
  'mipmap-xxxhdpi': 432,
}

// Adaptive icons scale the foreground to a 108dp canvas but only guarantee the
// inner 72dp "safe zone" survives every launcher's mask (circle/squircle/
// rounded-square all crop differently) — so the source art is scaled to fit
// within that safe zone (66% of the canvas) and centered on a transparent
// canvas. The transparent margin reveals the adaptive-icon background layer
// (ic_launcher_background, set to match the source's own black) underneath,
// so the result reads as one seamless black icon regardless of mask shape.
const SAFE_ZONE_FRACTION = 0.66

// ── Generator ─────────────────────────────────────────────────────────────────

async function generateLauncher(size, outPath) {
  await sharp(SOURCE).resize(size, size).png().toFile(outPath)
  console.log(`  ✓ ${path.relative(process.cwd(), outPath)} (${size}×${size})`)
}

async function generateForeground(size, outPath) {
  const artSize = Math.round(size * SAFE_ZONE_FRACTION)
  const art = await sharp(SOURCE).resize(artSize, artSize).toBuffer()
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: art, gravity: 'center' }])
    .png()
    .toFile(outPath)
  console.log(`  ✓ ${path.relative(process.cwd(), outPath)} (${size}×${size}, art ${artSize}×${artSize})`)
}

// iOS's single-size (1024×1024) App Store icon has one hard requirement
// Android's adaptive icon doesn't: it must carry NO alpha channel at all —
// Apple rejects/ignores a translucent App Store icon. The source file has an
// (unused, fully-opaque) alpha channel — sharp's flatten() composites it onto
// an explicit background color and drops the alpha channel entirely, which is
// exactly what's needed here (the background color barely matters since the
// source is already opaque black edge-to-edge, but #000000 matches it exactly
// in case that ever changes).
//
// Known quality caveat (tracked in CLAUDE.md's Outstanding Tasks): the source
// is only 192×192, so upscaling to 1024×1024 (~5.3×) is well past whatever
// blur an eye can forgive on flat vector-style art at small sizes — acceptable
// for now (same tradeoff Android's own 2.25× foreground upscale already
// accepted), but a real ≥1024×1024 master is the actual fix long-term.
async function generateIOSIcon() {
  const dir = path.dirname(IOS_APPICON)
  if (!fs.existsSync(dir)) {
    console.log(`  – skipping iOS icon (${path.relative(process.cwd(), dir)} doesn't exist — no ios/ scaffold on this machine)`)
    return
  }
  await sharp(SOURCE)
    .resize(1024, 1024)
    .flatten({ background: '#000000' })
    .png()
    .toFile(IOS_APPICON)
  console.log(`  ✓ ${path.relative(process.cwd(), IOS_APPICON)} (1024×1024, opaque)`)
}

async function main() {
  console.log('Generating Playwork app icons from', path.relative(process.cwd(), SOURCE), '\n')

  // Guarded on RES existing — this script is now called from BOTH
  // build-android.sh and build-ios.sh (see generateIOSIcon's own doc comment),
  // and either one may run on a machine where only the other platform's
  // scaffold exists (e.g. an Android-only Windows checkout, or an iOS-only
  // pass on a fresh Mac that hasn't run build-android.sh yet).
  if (fs.existsSync(RES)) {
    // ic_launcher.png + ic_launcher_round.png — same full-bleed source image;
    // the OS/launcher applies whatever mask shape it needs at display time.
    for (const [dir, size] of Object.entries(LAUNCHER_SIZES)) {
      const dest = (name) => path.join(RES, dir, name)
      await generateLauncher(size, dest('ic_launcher.png'))
      await generateLauncher(size, dest('ic_launcher_round.png'))
    }

    console.log()

    // ic_launcher_foreground.png — inset art for the adaptive-icon safe zone.
    for (const [dir, size] of Object.entries(FOREGROUND_SIZES)) {
      await generateForeground(size, path.join(RES, dir, 'ic_launcher_foreground.png'))
    }
  } else {
    console.log(`  – skipping Android icons (${path.relative(process.cwd(), RES)} doesn't exist — no android/ scaffold on this machine)`)
  }

  console.log()
  await generateIOSIcon()

  console.log('\nDone!')
}

main().catch((err) => { console.error(err); process.exit(1) })
