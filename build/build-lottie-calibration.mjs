// Generates the calibration-loop Lottie scenes (table + wall) rendered by
// `SensorModeSelect.tsx` via lottie-react. Each scene composites a generated
// illustration (hand + ball + surface, from `.lt/public/projects/playwork-
// calibration/<scene>/bg.png`) with a reactive vector dial+needle overlay —
// the image can't carry live rotation/color, everything else is static art.
//
// Usage — targets the text-to-lottie skill's verification player:
//   1. npx degit diffusionstudio/lottie <player-dir> && cd <player-dir> && npm install
//   2. drop bg.png into <player-dir>/public/projects/playwork-calibration/<scene>/
//   3. node tools/build/build-lottie-calibration.mjs <player-dir>
//   4. npm run dev in <player-dir>, verify in the browser (frame 0 = forward/red,
//      frame ~90 = up/green, frames 90-210 = green flash, frame 222 = reset) and
//      that the dial sits on the ball's plain, unobstructed left-front zone
//   5. re-embed with base64 for the app copy (see the inline node snippet used
//      each time in this project's session history) into
//      src/assets/lottie/calibration-{table,wall}.json
import fs from 'node:fs'
import path from 'node:path'

const FR = 60          // fps
const OP = 270         // 4.5s cycle @ 60fps

// ── color helpers ──────────────────────────────────────────────────────────
const hex = (h) => {
  const n = parseInt(h.replace('#', ''), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
const lerp  = (a, b, t) => a + (b - a) * t
const lerpColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]

const RED       = hex('#ef4444')
const GREEN     = hex('#22c55e')
const GREEN_DIM = hex('#14532d')
const GRAY_DK   = hex('#1f2937')
const DIAL_FILL = hex('#111318')
const DIAL_RING = hex('#e5e7eb')

// easeInOutCubic — smooth accel/decel, avoids the "linear" motion-taste anti-pattern
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

const lin = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } }

function kfColor(times, values) {
  const out = []
  for (let i = 0; i < times.length; i++) {
    const entry = { t: times[i], s: values[i] }
    if (i < times.length - 1) Object.assign(entry, lin)
    out.push(entry)
  }
  return { a: 1, k: out }
}

// ── Timeline ──────────────────────────────────────────────────────────────────
// The needle starts pointing FORWARD (horizontal, 90°) and rotates up to the
// ceiling-pointing orientation (0°). Color continuously lerps red -> green,
// keyed to the SAME eased progress driving the rotation, so "how green" always
// reflects "how close to vertical" — not a discrete jump. Once upright, it
// flashes green a few times, then snaps back to forward/red and loops.
const START_DEG    = 90
const ROTATE_FRAMES = 90    // 0 -> 90 frames (1.5s) to sweep from forward to up
const HOLD_END      = 210   // flash window ends here (3.5s)
const RESET_FRAME   = 222   // snap back to start (3.7s)

const SAMPLES = 30   // dense sampling of the eased rotation+color curve
const rotationTimes  = []
const rotationValues = []
const needleColorTimes  = []
const needleColorValues = []

for (let i = 0; i < SAMPLES; i++) {
  const t = i / (SAMPLES - 1)
  const p = easeInOutCubic(t)                 // 0 = forward/red, 1 = up/green
  const frame = Math.round(t * ROTATE_FRAMES)
  rotationTimes.push(frame)
  rotationValues.push(lerp(START_DEG, 0, p))
  needleColorTimes.push(frame)
  needleColorValues.push(lerpColor(RED, GREEN, p))
}

// Hold at upright + flash green a few times, then snap back to forward/red.
const flashTimes  = [100, 112, 124, 136, 148, 160, 172, 184, 196, HOLD_END]
const flashColors = flashTimes.map((_, i) => (i % 2 === 0 ? GREEN_DIM : GREEN))

rotationTimes.push(HOLD_END, RESET_FRAME, OP)
rotationValues.push(0, START_DEG, START_DEG)

needleColorTimes.push(...flashTimes, RESET_FRAME, OP)
needleColorValues.push(...flashColors, RED, RED)

const rotationProp = {
  a: 1,
  k: rotationTimes.map((t, i) => {
    const entry = { t, s: [rotationValues[i]] }
    if (i < rotationTimes.length - 1) Object.assign(entry, lin)
    return entry
  }),
}
const needleColorProp = kfColor(needleColorTimes, needleColorValues)

// ── shape helpers ────────────────────────────────────────────────────────────
let uid = 0
const nextName = (base) => `${base}_${uid++}`

function identityTransform() {
  return { ty: 'tr', p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 } }
}

function ellipseGroup(cx, cy, rx, ry, fillColor, opacityProp, strokeColor, strokeWidth) {
  const items = [
    { ty: 'el', p: { a: 0, k: [cx, cy] }, s: { a: 0, k: [rx * 2, ry * 2] } },
  ]
  if (fillColor) items.push({ ty: 'fl', c: { a: 0, k: [...fillColor, 1] }, o: opacityProp ?? { a: 0, k: 100 } })
  if (strokeColor) items.push({ ty: 'st', c: { a: 0, k: [...strokeColor, 1] }, w: { a: 0, k: strokeWidth ?? 1 }, o: { a: 0, k: 100 } })
  items.push(identityTransform())
  return { ty: 'gr', it: items, nm: nextName('ellipse') }
}

function triangleGroup(points, colorProp) {
  const verts = points.map(([x, y]) => [x, y])
  return {
    ty: 'gr',
    it: [
      { ty: 'sh', ks: { a: 0, k: { c: true, v: verts, i: verts.map(() => [0, 0]), o: verts.map(() => [0, 0]) } } },
      { ty: 'fl', c: colorProp, o: { a: 0, k: 100 } },
      identityTransform(),
    ],
    nm: nextName('tri'),
  }
}

// ── shape layer wrapper ──────────────────────────────────────────────────────
function shapeLayer(name, shapes, { rotation, anchor, position, ind } = {}) {
  const ks = {
    o: { a: 0, k: 100 },
    r: rotation ?? { a: 0, k: 0 },
    p: { a: 0, k: position ?? [0, 0] },
    a: { a: 0, k: anchor ?? [0, 0] },
    s: { a: 0, k: [100, 100] },
  }
  return {
    ddd: 0, ind, ty: 4, nm: name, sr: 1, ks, ao: 0,
    shapes, ip: 0, op: OP, st: 0, bm: 0,
  }
}

// ── image asset + layer — generated background illustration ─────────────────
// Relative file path (e:0) — what the text-to-lottie skill's Skottie/CanvasKit
// player wants (`p`: bare filename next to lottie.json in its scene folder).
// The app copy re-embeds this as base64 (e:1) separately, since lottie-react/
// lottie-web in the Vite app has no assetsPath wired up and embedding avoids
// that static-file config entirely (standard practice for single-file Lottie).
function imageAsset(id, w, h, filename) {
  return { id, w, h, u: '', p: filename, e: 0 }
}

function imageLayer(name, refId, ind) {
  return {
    ddd: 0, ind, ty: 2, nm: name, refId, sr: 1,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
      p: { a: 0, k: [0, 0] }, a: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] },
    },
    ao: 0, ip: 0, op: OP, st: 0, bm: 0,
  }
}

// ── ball + dial + needle rig (shared by both scenes) ─────────────────────────
// The ball's left side is visible, carrying a circular dial (the plug) with a
// triangular needle that must rotate from "forward" (horizontal) to "up"
// (pointing at the ceiling). dialR is exposed as an absolute px value (not
// derived from a vector ball radius) so image-background scenes can size the
// dial to match the actual illustrated ball in the generated artwork.
function dialRig({ dialX, dialY, dialR, ind }) {
  const hubR = dialR * 0.16
  // Elongated needle triangle: narrow base near the hub, tapering to a point
  // near the dial's edge — reads clearly as a pointer without a separate stem.
  const tipY  = -dialR * 0.85
  const baseY = -dialR * 0.18
  const baseHalfWidth = dialR * 0.16

  // Rotating assembly: anchor + position both at the dial center so the needle
  // spins in place, rigidly fixed to the ball's surface like the plug itself.
  return shapeLayer('RotatingAssembly-Dial', [
    // Needle — the only colored element (fill lerps/flashes red -> green).
    triangleGroup([
      [0, tipY], [-baseHalfWidth, baseY], [baseHalfWidth, baseY],
    ], needleColorProp),

    // Dial face — static grayscale ring + hub (the plug), does not carry color.
    ellipseGroup(0, 0, hubR, hubR, GRAY_DK, undefined, DIAL_RING, 1),
    ellipseGroup(0, 0, dialR, dialR, DIAL_FILL, undefined, DIAL_RING, 1.5),
  ], { ind, anchor: [0, 0], position: [dialX, dialY], rotation: rotationProp })
}

// ── image-background scene builder ──────────────────────────────────────────
// Uses a generated illustration (hand + ball + surface) as the base layer,
// with only the reactive dial+needle kept as vector shapes on top — the image
// can't carry the live rotation/color-lerp, everything else can be a static
// asset. Composition size matches the image's native pixels so ballCx/ballCy/
// ballR (the dial's target position) are just the image's own pixel coords.
// dialScale (S-70): the dial/"plug" is rendered at dialR = ballR * dialScale —
// exposed per-scene (default 0.34, matching the original single constant)
// rather than hardcoded, so a scene's plug size can be tuned smaller relative
// to its own ball without touching the other scene or the ball-position math
// (dialX/dialY only depend on ballR, not dialScale).
function imageScene(nm, filename, imgW, imgH, ballCx, ballCy, ballR, dialScale = 0.34) {
  uid = 0
  const bg = imageAsset('bg_0', imgW, imgH, filename)
  const bgLayer = imageLayer('Background', 'bg_0', 2)
  const dial = dialRig({ dialX: ballCx - ballR * 0.62, dialY: ballCy, dialR: ballR * dialScale, ind: 1 })
  return {
    v: '5.9.0', fr: FR, ip: 0, op: OP, w: imgW, h: imgH, nm,
    ddd: 0, assets: [bg], layers: [dial, bgLayer],
  }
}

// ── write scenes ─────────────────────────────────────────────────────────────
// Both scenes use their generated illustration (bg.png, dropped into each
// scene folder alongside lottie.json) with the dial overlay calibrated to the
// ball's visible position in that image (ballCx/ballCy/ballR below).
const root = process.argv[2]
if (!root) { console.error('usage: node build-lottie-calibration.mjs <player-project-dir>'); process.exit(1) }

const scenes = [
  ['table', () => imageScene('Calibration - Table', 'bg.png', 896, 1193, 315, 580, 230)],
  // S-70: plug ("dial") sized smaller relative to the ball specifically for
  // Wall mode (0.34 -> 0.27) per the reported "plug should be a bit smaller
  // relative to the ball's size" — Table mode's dial is unaffected.
  ['wall', () => imageScene('Calibration - Wall', 'bg.png', 896, 1193, 477, 575, 215, 0.27)],
]

for (const [slug, build] of scenes) {
  const dir = path.join(root, 'public', 'projects', 'playwork-calibration', slug)
  fs.mkdirSync(dir, { recursive: true })
  const doc = build()
  fs.writeFileSync(path.join(dir, 'lottie.json'), JSON.stringify(doc, null, 2))
  console.log('wrote', path.join(dir, 'lottie.json'))
}
