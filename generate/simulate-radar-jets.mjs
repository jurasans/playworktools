#!/usr/bin/env node
/**
 * Parametric Tactical Jet Radar Simulator v4
 *
 * Features:
 *  - Friendly (cyan/blue) + Enemy (glowing red) aircraft on clean tactical map
 *  - SAM sites with pulsing range rings and rotating radar arm
 *  - Enemy runways / airbases
 *  - Ultra-slow realistic velocity (0.0018 speed = planes crawl across map)
 *  - Last ~4s: "DISCONNECT" sequence — friendly jets go dark red, red bounding
 *    box, blinking yellow "נתק" label, screen-wide red aura — in wave form
 *  - Enemy aircraft unaffected by disconnect
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn, execSync } from 'child_process'
import sharp from 'sharp'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── Config ─────────────────────────────────────────────────────────────────
const DEFAULTS = {
  baseMap:     path.join(__dirname, 'vars', 'radar-base.png'),
  duration:    70.0,    // 60s normal flight + 10s disconnect sequence
  fps:         30,
  speed:       0.08,    // 10% of previous velocity — ultra-realistic slow crawl
  sweep:       false,
  sweepRpm:    12,
  sweepCenter: [355, 235],
  sweepRadius: 680,
  showTags:    true,
  showTrails:  true,
  trailLength: 5,
  is4k:        false,   // 4K Ultra-HD resolution (3840x2160 standard UHD)
  out:         path.join(__dirname, 'data', 'radar-jets-sim'),
}

const DISCONNECT_START  = 60.0  // seconds: normal loop for 60s, disconnect in last 10s
const DISCONNECT_WINDOW = 4.5   // seconds: wave duration (sporadic, not all at once)

// Deterministic pseudo-random [0,1) from integer seed
function seededRand(seed) {
  const x = Math.sin(seed * 9301 + 49297) * 233280
  return x - Math.floor(x)
}

function parseArgs(argv) {
  const args = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i]
    switch (a) {
      case '--4k':        args.is4k      = true; break
      case '--duration':  args.duration  = parseFloat(next()); break
      case '--fps':       args.fps       = parseInt(next(), 10); break
      case '--speed':     args.speed     = parseFloat(next()); break
      case '--sweep':     args.sweep     = true; break
      case '--no-sweep':  args.sweep     = false; break
      case '--sweep-rpm': args.sweepRpm  = parseFloat(next()); break
      case '--no-tags':   args.showTags  = false; break
      case '--no-trails': args.showTrails = false; break
      case '--trail-len': args.trailLength = parseInt(next(), 10); break
      case '--out':       args.out       = path.resolve(next()); break
    }
  }
  return args
}

// ── Aircraft SVG Icons ─────────────────────────────────────────────────────
function getAircraftSvg(type, color) {
  switch (type) {
    case 'fighter':
      // Compact delta fighter
      return `<path d="M 0,-6 L 1.5,-2 L 5,2 L 5,3.5 L 1.5,2.5 L 1.5,5 L 3,6 L 3,7 L 0,6.5 L -3,7 L -3,6 L -1.5,5 L -1.5,2.5 L -5,3.5 L -5,2 L -1.5,-2 Z" fill="${color}" stroke="#001a22" stroke-width="0.5"/>`
    case 'mig21':
      // Slim tailed delta — MiG-21 silhouette
      return `<path d="M 0,-7 L 1.2,-1 L 5,2.5 L 4,5 L 1,3.5 L 0,6 L -1,3.5 L -4,5 L -5,2.5 L -1.2,-1 Z" fill="${color}" stroke="#220000" stroke-width="0.5"/>`
    case 'f14':
      // Wider swept-wing F-14 (beefier than MiG)
      return `<path d="M 0,-8 L 1.5,-2 L 7,1.5 L 6,4 L 2,3 L 2,6.5 L 4,8 L -4,8 L -2,6.5 L -2,3 L -6,4 L -7,1.5 L -1.5,-2 Z" fill="${color}" stroke="#220000" stroke-width="0.5"/>`
    case 'uav':
      // High-aspect drone
      return `<path d="M 0,-5 L 1,-1 L 7,-0.5 L 7,1 L 1,0.5 L 1,4 L 2.5,5 L -2.5,5 L -1,4 L -1,0.5 L -7,1 L -7,-0.5 L -1,-1 Z" fill="${color}" stroke="#001a22" stroke-width="0.5"/>`
    default:
      // AWACS
      return `<path d="M 0,-7 L 1.5,-2.5 L 7,0 L 7,2 L 1.5,1.5 L 1.5,5.5 L 3.5,7 L -3.5,7 L -1.5,5.5 L -1.5,1.5 L -7,2 L -7,0 L -1.5,-2.5 Z" fill="${color}" stroke="#001a22" stroke-width="0.5"/>
              <circle cx="0" cy="0.5" r="2.5" fill="none" stroke="${color}" stroke-width="0.9"/>`
  }
}

// ── Catmull-Rom closed spline ──────────────────────────────────────────────
function interpolateSpline(pts, tNorm) {
  const n = pts.length
  const p = tNorm * n
  const i0 = Math.floor(p) % n
  const f = p - Math.floor(p), f2 = f*f, f3 = f2*f
  const im1 = (i0-1+n)%n, ip1 = (i0+1)%n, ip2 = (i0+2)%n
  const [p0,p1,p2,p3] = [pts[im1],pts[i0],pts[ip1],pts[ip2]]
  const x  = 0.5*((2*p1[0])+(-p0[0]+p2[0])*f+(2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*f2+(-p0[0]+3*p1[0]-3*p2[0]+p3[0])*f3)
  const y  = 0.5*((2*p1[1])+(-p0[1]+p2[1])*f+(2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*f2+(-p0[1]+3*p1[1]-3*p2[1]+p3[1])*f3)
  const dx = 0.5*((-p0[0]+p2[0])+(4*p0[0]-10*p1[0]+8*p2[0]-2*p3[0])*f+(-3*p0[0]+9*p1[0]-9*p2[0]+3*p3[0])*f2)
  const dy = 0.5*((-p0[1]+p2[1])+(4*p0[1]-10*p1[1]+8*p2[1]-2*p3[1])*f+(-3*p0[1]+9*p1[1]-9*p2[1]+3*p3[1])*f2)
  return { x, y, headingDeg: (Math.atan2(dy,dx)*180/Math.PI+90+360)%360 }
}

function mkPlane(base, phaseOffset, overrides = {}) {
  return { ...base, phaseOffset: (base.phaseOffset||0) + phaseOffset, ...overrides }
}

// ═══════════════════════════════════════════════════════════════════════════
//  FRIENDLY FLEET  (cyan / blue)
// ═══════════════════════════════════════════════════════════════════════════

const IRAN_STRIKE = {
  type:'fighter', speedKts:530, color:'#00f0ff', phaseOffset:0,
  waypoints:[
    [340,300],[390,270],[450,240],[530,215],
    [630,200],[720,185],[800,190],[870,210],
    [900,240],[870,260],[800,270],[720,265],
    [630,280],[530,300],[440,315],[380,320]
  ]
}
const IRAQ_STRIKE = {
  type:'fighter', speedKts:510, color:'#38bdf8', phaseOffset:0,
  waypoints:[
    [345,330],[400,340],[470,330],[560,300],
    [650,275],[730,260],[780,275],[760,310],
    [690,330],[600,345],[510,355],[430,355],[370,350]
  ]
}
const ISRAEL_CAP = {
  type:'fighter', speedKts:450, color:'#00f0ff', phaseOffset:0,
  waypoints:[[318,290],[340,280],[360,285],[368,305],[355,325],[332,328],[315,312]]
}
const MED_CAP = {
  type:'fighter', speedKts:470, color:'#38bdf8', phaseOffset:0,
  waypoints:[[210,165],[260,150],[295,170],[290,215],[255,235],[210,220],[190,190]]
}
const EILAT_PATROL = {
  type:'fighter', speedKts:440, color:'#00e5ff', phaseOffset:0,
  waypoints:[[360,435],[368,460],[372,495],[362,520],[348,505],[344,475],[350,450]]
}
const NORTH_CAP = {
  type:'fighter', speedKts:490, color:'#00f0ff', phaseOffset:0,
  waypoints:[[335,215],[370,200],[410,198],[445,212],[440,240],[400,248],[360,240],[330,232]]
}
const AWACS_ORBIT = {
  type:'awacs', speedKts:310, color:'#a78bfa', phaseOffset:0,
  waypoints:[[115,145],[175,130],[215,155],[210,200],[165,220],[115,205],[95,175]]
}
const ISR_UAV = {
  type:'uav', speedKts:185, color:'#34d399', phaseOffset:0,
  waypoints:[[480,155],[555,145],[620,155],[650,185],[620,215],[545,220],[475,205]]
}

const FRIENDLY_FLEET = [
  // Iran strike package (6 fighters staggered along corridor)
  { ...IRAN_STRIKE, callsign:'F-35 #01', phaseOffset:0.00 },
  mkPlane(IRAN_STRIKE, 0.12, { callsign:'F-35 #02' }),
  mkPlane(IRAN_STRIKE, 0.24, { callsign:'F-15 #03', color:'#38bdf8' }),
  mkPlane(IRAN_STRIKE, 0.37, { callsign:'F-15 #04', color:'#38bdf8' }),
  mkPlane(IRAN_STRIKE, 0.50, { callsign:'F-16 #05', color:'#00e5ff' }),
  mkPlane(IRAN_STRIKE, 0.63, { callsign:'F-16 #06', color:'#00e5ff' }),
  // Iraq strike corridor (5 fighters)
  { ...IRAQ_STRIKE, callsign:'F-15 #11', phaseOffset:0.00 },
  mkPlane(IRAQ_STRIKE, 0.15, { callsign:'F-15 #12' }),
  mkPlane(IRAQ_STRIKE, 0.30, { callsign:'F-16 #13', color:'#00f0ff' }),
  mkPlane(IRAQ_STRIKE, 0.45, { callsign:'F-16 #14', color:'#00f0ff' }),
  mkPlane(IRAQ_STRIKE, 0.60, { callsign:'F-35 #15', color:'#00e5ff' }),
  // Israel CAP (4)
  { ...ISRAEL_CAP, callsign:'F-16 #21', phaseOffset:0.00 },
  mkPlane(ISRAEL_CAP, 0.25, { callsign:'F-16 #22' }),
  mkPlane(ISRAEL_CAP, 0.50, { callsign:'F-35 #23', color:'#38bdf8' }),
  mkPlane(ISRAEL_CAP, 0.75, { callsign:'F-35 #24', color:'#38bdf8' }),
  // Mediterranean CAP (3)
  { ...MED_CAP, callsign:'F-15 #31', phaseOffset:0.00 },
  mkPlane(MED_CAP, 0.33, { callsign:'F-15 #32' }),
  mkPlane(MED_CAP, 0.66, { callsign:'F-16 #33', color:'#00e5ff' }),
  // Eilat patrol (3)
  { ...EILAT_PATROL, callsign:'F-16 #41', phaseOffset:0.00 },
  mkPlane(EILAT_PATROL, 0.33, { callsign:'F-16 #42' }),
  mkPlane(EILAT_PATROL, 0.66, { callsign:'F-15 #43', color:'#38bdf8' }),
  // Northern border CAP (3)
  { ...NORTH_CAP, callsign:'F-35 #51', phaseOffset:0.00 },
  mkPlane(NORTH_CAP, 0.33, { callsign:'F-35 #52' }),
  mkPlane(NORTH_CAP, 0.66, { callsign:'F-16 #53', color:'#38bdf8' }),
  // ISR UAVs (2)
  { ...ISR_UAV, callsign:'UAV #61', phaseOffset:0.00 },
  mkPlane(ISR_UAV, 0.5, { callsign:'UAV #62' }),
  // AWACS
  { ...AWACS_ORBIT, callsign:'AWACS-01', phaseOffset:0.00 },
]

// Assign each friendly plane a deterministic disconnect time within the wave window
FRIENDLY_FLEET.forEach((plane, i) => {
  plane.disconnectAt = DISCONNECT_START + seededRand(i + 13) * DISCONNECT_WINDOW
})

// ═══════════════════════════════════════════════════════════════════════════
//  ENEMY FLEET  (bright glowing red — never disconnect)
// ═══════════════════════════════════════════════════════════════════════════

const IRAN_F14 = {
  type:'f14', speedKts:480, color:'#ff2200', phaseOffset:0,
  waypoints:[[828,172],[865,160],[898,178],[893,215],[858,228],[822,212],[810,188]]
}
const IRAN_MIG_S = {
  type:'mig21', speedKts:420, color:'#ff3300', phaseOffset:0,
  waypoints:[[808,298],[843,284],[864,304],[850,334],[814,340],[793,320]]
}
const IRAQ_MIG = {
  type:'mig21', speedKts:400, color:'#ff3300', phaseOffset:0,
  waypoints:[[693,254],[724,244],[744,264],[730,290],[699,290],[678,268]]
}

const ENEMY_FLEET = [
  { ...IRAN_F14,   callsign:'F-14▲',    phaseOffset:0.00 },
  { ...IRAN_MIG_S, callsign:'MIG-21▲',  phaseOffset:0.00 },
  mkPlane(IRAN_MIG_S, 0.5, { callsign:'MIG-21▲' }),
  { ...IRAQ_MIG,   callsign:'MIG-21▲',  phaseOffset:0.00 },
  mkPlane(IRAQ_MIG, 0.5, { callsign:'MIG-21▲' }),
]

// ═══════════════════════════════════════════════════════════════════════════
//  STATIC FEATURES
// ═══════════════════════════════════════════════════════════════════════════

const SAM_SITES = [
  { x:802, y:176, label:'SA-10', range:50 },   // Iran — NW (near Tehran)
  { x:852, y:308, label:'SA-6',  range:36 },   // Iran — central
  { x:922, y:238, label:'SA-10', range:48 },   // Iran — east
  { x:688, y:247, label:'SA-6',  range:34 },   // Iraq — Baghdad area
  { x:626, y:212, label:'SA-3',  range:28 },   // Iraq — western desert
]

const ENEMY_RUNWAYS = [
  { x:858, y:190, label:'IRAN AB',  angle:12 },   // Iranian airbase
  { x:708, y:263, label:'IRAQ AB',  angle:-18 },  // Iraqi airbase
]

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN RENDER LOOP
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const args = parseArgs(process.argv.slice(2))
  fs.mkdirSync(args.out, { recursive: true })

  console.log(`[radar-jets] v4 — tactical simulation with enemy contacts + disconnect sequence`)
  console.log(`  duration:   ${args.duration}s @ ${args.fps}fps  (${Math.round(args.duration*args.fps)} frames)`)
  console.log(`  resolution: ${args.is4k ? '4K Ultra-HD (3840x2160 standard UHD)' : 'Native (1024x558)'}`)
  console.log(`  friendly:   ${FRIENDLY_FLEET.length} aircraft`)
  console.log(`  enemy:      ${ENEMY_FLEET.length} aircraft  +  ${SAM_SITES.length} SAM sites`)
  console.log(`  disconnect: wave starts at t=${DISCONNECT_START}s over ${DISCONNECT_WINDOW}s`)

  const baseMetadata = await sharp(args.baseMap).metadata()
  const W = baseMetadata.width  || 1024
  const H = baseMetadata.height || 558
  const totalFrames = Math.round(args.duration * args.fps)

  const is4k = args.is4k
  const targetW = is4k ? 3840 : W
  const targetH = is4k ? 2092 : H
  const base4kPath = path.join(__dirname, 'vars', 'radar-base-4k.png')

  let baseMapPath = args.baseMap
  if (is4k) {
    if (!fs.existsSync(base4kPath)) {
      console.log(`[radar-jets] generating 4K base map with Lanczos3 upscale + unsharp sharpening...`)
      await sharp(args.baseMap)
        .resize(3840, 2092, { kernel: 'lanczos3' })
        .sharpen({ sigma: 1.2, m1: 0.8, m2: 1.5 })
        .png({ compressionLevel: 6 })
        .toFile(base4kPath)
    }
    baseMapPath = base4kPath
  }

  const { data: rawBase, info: rawInfo } = await sharp(baseMapPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Pre-compute ALL aircraft positions for every frame
  const allFleet  = [...FRIENDLY_FLEET, ...ENEMY_FLEET]
  const history   = allFleet.map(() => [])

  for (let f = 0; f < totalFrames; f++) {
    const t = f / args.fps
    for (let a = 0; a < allFleet.length; a++) {
      const plane = allFleet[a]
      const cyc   = (t / args.duration) * args.speed
      const tNorm = ((cyc + (plane.phaseOffset||0)) % 1.0 + 1.0) % 1.0
      history[a].push(interpolateSpline(plane.waypoints, tNorm))
    }
  }

  function getSvgForFrame(f) {
    const t     = f / args.fps
    const twoPi = 2 * Math.PI
    let els = []

    // ── 1. SAM Sites ──────────────────────────────────────────────────────
    for (const sam of SAM_SITES) {
      const { x, y, label, range } = sam
      const ringPulse = (0.25 + 0.12 * Math.sin(t * twoPi * 0.6)).toFixed(2)
      els.push(`<circle cx="${x}" cy="${y}" r="${range}" fill="none" stroke="#ff2200" stroke-width="0.5" stroke-dasharray="3,3" opacity="${ringPulse}"/>`)
      els.push(`<circle cx="${x}" cy="${y}" r="${range*0.45}" fill="none" stroke="#ff2200" stroke-width="0.4" stroke-dasharray="2,4" opacity="0.2"/>`)
      const armAngle = (t * twoPi * (args.sweepRpm / 60)) % twoPi
      const ax = x + range * 0.75 * Math.cos(armAngle)
      const ay = y + range * 0.75 * Math.sin(armAngle)
      els.push(`<line x1="${x}" y1="${y}" x2="${ax.toFixed(1)}" y2="${ay.toFixed(1)}" stroke="#ff3300" stroke-width="0.7" opacity="0.55"/>`)
      els.push(`<polygon points="${x},${y-5} ${x+3.5},${y} ${x},${y+5} ${x-3.5},${y}" fill="#ff2200" opacity="0.95"/>`)
      els.push(`<text x="${x+5}" y="${y+2}" fill="#ff5533" font-size="5" font-family="monospace" font-weight="bold">${label}</text>`)
    }

    // ── 2. Enemy Runways ──────────────────────────────────────────────────
    for (const rwy of ENEMY_RUNWAYS) {
      const { x, y, label, angle } = rwy
      els.push(`<g transform="translate(${x},${y}) rotate(${angle})">
        <rect x="-15" y="-3.5" width="30" height="7" fill="#cc1100" opacity="0.55" rx="1"/>
        <line x1="-15" y1="0" x2="15" y2="0" stroke="#ff4422" stroke-width="0.5" stroke-dasharray="3,2" opacity="0.9"/>
        <line x1="0" y1="-3.5" x2="0" y2="3.5" stroke="#ff4422" stroke-width="0.4" opacity="0.6"/>
      </g>`)
      els.push(`<text x="${x}" y="${y+13}" fill="#ff4422" font-size="5.5" text-anchor="middle" font-family="monospace" font-weight="bold">${label}</text>`)
    }

    // ── 3. Enemy Fleet (always active, bright glowing red) ─────────────────
    for (let a = 0; a < ENEMY_FLEET.length; a++) {
      const plane = ENEMY_FLEET[a]
      const ai    = FRIENDLY_FLEET.length + a
      const pos   = history[ai][f]

      const haloP = (0.32 + 0.2 * Math.sin(t * Math.PI * 1.5)).toFixed(2)
      els.push(`<circle cx="${pos.x.toFixed(1)}" cy="${pos.y.toFixed(1)}" r="10" fill="none" stroke="#ff2200" stroke-width="1.8" opacity="${haloP}"/>`)

      if (args.showTrails) {
        for (let i = 1; i <= args.trailLength; i++) {
          const hi = ((f - i * 16) % totalFrames + totalFrames) % totalFrames
          const pp = history[ai][hi]
          if (pp) {
            const op = Math.max(0.12, (1 - i / args.trailLength) * 0.6).toFixed(2)
            els.push(`<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="1.3" fill="#ff2200" opacity="${op}"/>`)
          }
        }
      }

      els.push(`<g transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) rotate(${pos.headingDeg.toFixed(1)})">${getAircraftSvg(plane.type, plane.color)}</g>`)

      if (args.showTags) {
        const tx = pos.x + 9
        els.push(`<g font-family="monospace" font-size="6" fill="#ff5533" font-weight="bold">
          <rect x="${tx.toFixed(1)}" y="${(pos.y-9).toFixed(1)}" width="40" height="14" fill="#1a0000" opacity="0.75" rx="1" stroke="#ff2200" stroke-width="0.4"/>
          <text x="${(tx+2).toFixed(1)}" y="${(pos.y-3).toFixed(1)}">${plane.callsign}</text>
          <text x="${(tx+2).toFixed(1)}" y="${(pos.y+4).toFixed(1)}">${plane.speedKts}kt</text>
        </g>`)
      }
    }

    // ── 4. Friendly Fleet ─────────────────────────────────────────────────
    for (let a = 0; a < FRIENDLY_FLEET.length; a++) {
      const plane = FRIENDLY_FLEET[a]
      const pos   = history[a][f]
      const discon = t >= plane.disconnectAt

      const iconColor  = discon ? '#780404' : plane.color
      const trailColor = discon ? '#4d0000' : plane.color

      if (args.showTrails) {
        for (let i = 1; i <= args.trailLength; i++) {
          const hi = ((f - i * 16) % totalFrames + totalFrames) % totalFrames
          const pp = history[a][hi]
          if (pp) {
            const op = Math.max(0.12, (1 - i / args.trailLength) * 0.7).toFixed(2)
            const r  = Math.max(0.9, 1.8 - i * 0.15).toFixed(1)
            els.push(`<circle cx="${pp.x.toFixed(1)}" cy="${pp.y.toFixed(1)}" r="${r}" fill="${trailColor}" opacity="${op}"/>`)
          }
        }
      }

      if (!discon) {
        const rad = (pos.headingDeg - 90) * Math.PI / 180
        const vx  = pos.x + 10 * Math.cos(rad)
        const vy  = pos.y + 10 * Math.sin(rad)
        els.push(`<line x1="${pos.x.toFixed(1)}" y1="${pos.y.toFixed(1)}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" stroke="${iconColor}" stroke-width="0.9" stroke-dasharray="2,2" opacity="0.55"/>`)
      }

      els.push(`<g transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)}) rotate(${pos.headingDeg.toFixed(1)})">${getAircraftSvg(plane.type, iconColor)}</g>`)

      if (discon) {
        // ── DISCONNECT EFFECT: red square with bright glowing blinking yellow "נתק" inside ──
        const blink   = Math.sin(t * Math.PI * 7) > 0
        const blinkOp = blink ? 1.0 : 0.12

        const bs = 13       // square half-size (26x26 square)
        const bc = bs + 3   // corner bracket offset
        const cm = 4.5      // corner tick length

        // Red square surrounding the jet
        els.push(`<rect x="${(pos.x-bs).toFixed(1)}" y="${(pos.y-bs).toFixed(1)}" width="${bs*2}" height="${bs*2}" fill="#330000" fill-opacity="0.3" stroke="#ff0000" stroke-width="1.2" opacity="0.95"/>`)

        // Corner bracket accents
        const corners = [
          [[pos.x-bc, pos.y-bc], [pos.x-bc+cm, pos.y-bc]],
          [[pos.x-bc, pos.y-bc], [pos.x-bc,    pos.y-bc+cm]],
          [[pos.x+bc-cm, pos.y-bc], [pos.x+bc, pos.y-bc]],
          [[pos.x+bc,    pos.y-bc], [pos.x+bc, pos.y-bc+cm]],
          [[pos.x-bc, pos.y+bc-cm], [pos.x-bc, pos.y+bc]],
          [[pos.x-bc, pos.y+bc],    [pos.x-bc+cm, pos.y+bc]],
          [[pos.x+bc, pos.y+bc-cm], [pos.x+bc, pos.y+bc]],
          [[pos.x+bc-cm, pos.y+bc], [pos.x+bc, pos.y+bc]],
        ]
        for (const [[x1,y1],[x2,y2]] of corners) {
          els.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#ff2200" stroke-width="1.4" opacity="0.95"/>`)
        }

        // Inside the square: glowing blinking yellow "נתק" badge
        els.push(`<g opacity="${blinkOp.toFixed(2)}">
          <rect x="${(pos.x-11).toFixed(1)}" y="${(pos.y-bs+2).toFixed(1)}" width="22" height="9" fill="#200000" opacity="0.9" rx="1.5" stroke="#ff2200" stroke-width="0.5"/>
          <text x="${pos.x.toFixed(1)}" y="${(pos.y-bs+9).toFixed(1)}" text-anchor="middle" font-family="'Segoe UI', Arial, sans-serif" font-size="7.5" font-weight="900" fill="#ffff00" filter="url(#yellowGlow)">נתק</text>
        </g>`)

      } else {
        if (args.showTags) {
          const tx = pos.x + 8
          els.push(`<g font-family="monospace" font-size="6.5" fill="${plane.color}" font-weight="bold">
            <rect x="${tx.toFixed(1)}" y="${(pos.y-9).toFixed(1)}" width="43" height="16" fill="#031525" opacity="0.65" rx="2" stroke="${plane.color}" stroke-width="0.35"/>
            <text x="${(tx+2).toFixed(1)}" y="${(pos.y-2).toFixed(1)}">${plane.callsign}</text>
            <text x="${(tx+2).toFixed(1)}" y="${(pos.y+6).toFixed(1)}">${plane.speedKts}kt</text>
          </g>`)
        }
      }
    }

    // ── 5. Screen-wide glowing blinking red aura (starts at t=60s) ───────────
    if (t >= DISCONNECT_START) {
      const prog  = Math.min(1.0, (t - DISCONNECT_START) / 2.5)  // ramp in over 2.5s
      const blink = 0.5 + 0.5 * Math.sin(t * Math.PI * 4)        // 2 Hz alert pulse

      // Vignette radial aura
      els.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="url(#screenRedAura)"/>`)

      // Ambient screen tint
      const fillOp = (prog * 0.08 * blink).toFixed(3)
      els.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#dd0000" opacity="${fillOp}"/>`)

      // Outer alert border frame
      const strokeOp = Math.min(0.65, prog * 0.45 + 0.2 * blink).toFixed(3)
      els.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ff0000" stroke-width="36" opacity="${strokeOp}"/>`)
      els.push(`<rect x="18" y="18" width="${W-36}" height="${H-36}" fill="none" stroke="#ff3300" stroke-width="8" opacity="${(strokeOp*0.6).toFixed(3)}"/>`)
    }

    // Assemble SVG
    const progVal = t >= DISCONNECT_START ? Math.min(1.0, (t - DISCONNECT_START) / 2.5) : 0
    const blinkVal = 0.5 + 0.5 * Math.sin(t * Math.PI * 4)
    return `<svg width="${targetW}" height="${targetH}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <filter id="yellowGlow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.0" result="coloredBlur"/>
          <feMerge>
            <feMergeNode in="coloredBlur"/>
            <feMergeNode in="SourceGraphic"/>
          </feMerge>
        </filter>
        <radialGradient id="screenRedAura" cx="50%" cy="50%" r="58%" fx="50%" fy="50%">
          <stop offset="60%" stop-color="#ff0000" stop-opacity="0"/>
          <stop offset="85%" stop-color="#ff0000" stop-opacity="${(progVal * 0.35 * blinkVal).toFixed(3)}"/>
          <stop offset="100%" stop-color="#cc0000" stop-opacity="${(progVal * 0.70 * blinkVal).toFixed(3)}"/>
        </radialGradient>
      </defs>
      ${els.join('\n')}
    </svg>`
  }

  // ── Setup FFmpeg Direct Streaming Pipe ──────────────────────────────────
  const mp4Filename = is4k ? 'radar_autonomous_jets_4k.mp4' : 'radar_autonomous_jets_loop.mp4'
  const mp4Out  = path.join(args.out, mp4Filename)

  console.log(`[radar-jets] streaming 4K frames directly into FFmpeg...`)
  const ffmpegArgs = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${rawInfo.width}x${rawInfo.height}`,
    '-r', String(args.fps),
    '-i', 'pipe:0',
  ]
  if (is4k) {
    ffmpegArgs.push('-vf', 'pad=3840:2160:(ow-iw)/2:(oh-ih)/2:color=black')
  }
  ffmpegArgs.push(
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-crf', '15',
    '-preset', 'fast',
    mp4Out
  )

  const ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'inherit', 'inherit'] })

  for (let f = 0; f < totalFrames; f++) {
    const svg = getSvgForFrame(f)
    const buf = await sharp(rawBase, { raw: { width: rawInfo.width, height: rawInfo.height, channels: 4 } })
      .composite([{ input: Buffer.from(svg) }])
      .raw()
      .toBuffer()

    if (!ffmpegProc.stdin.write(buf)) {
      await new Promise(resolve => ffmpegProc.stdin.once('drain', resolve))
    }

    if ((f + 1) % 30 === 0 || f === totalFrames - 1) {
      process.stdout.write(`  rendered & encoded ${f + 1}/${totalFrames} frames (${Math.round((f + 1) / totalFrames * 100)}%)\r`)
    }
  }

  ffmpegProc.stdin.end()
  await new Promise((resolve, reject) => {
    ffmpegProc.on('close', code => (code === 0 ? resolve() : reject(new Error(`FFmpeg exited with ${code}`))))
  })

  console.log(`\n[radar-jets] ✓ done`)
  console.log(`  MP4:  ${mp4Out}`)
}

main().catch(console.error)
