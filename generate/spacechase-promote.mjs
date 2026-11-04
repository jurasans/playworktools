#!/usr/bin/env node
// Promotes the picks saved in spec-web's Images tab into public/images/spacechase/*.webp (sprites get
// background removal via postprocess.mjs, backgrounds only resize), then marks them integrated in the Images tab and in
// data/spacechase/selection.json. Usage: node spacechase-promote.mjs [--dry-run]
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { markIntegrated, writeSelectionManifest, keptKey } from '../../tools/spec-web/images-lib.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const stateFile = process.env.IMG_STATE || path.join(repo, 'tools', 'spec-web', 'documentation', 'state', 'images-state.json')
const dataDir = path.join(here, 'data', 'spacechase')
const outDir = process.env.IMG_OUT || path.join(repo, 'public', 'images', 'spacechase')
const dry = process.argv.includes('--dry-run')

// asset key (group/key as listed in the Images tab) -> file name the game loads (src/games/spacechase/draw.ts)
const TARGETS = {
  'player/player_spaceship_standard_flight': ['ship', 'sprite'],
  'enemy/enemy_spaceship_pursuit': ['enemy', 'sprite'],
  'asteroid/asteroid_round_smooth': ['asteroid_1', 'sprite'],
  'asteroid/asteroid_jagged_angular': ['asteroid_2', 'sprite'],
  'asteroid/asteroid_long_oval': ['asteroid_3', 'sprite'],
  'asteroid/asteroid_cratered_large': ['asteroid_4', 'sprite'],
  'asteroid/asteroid_small_chunky': ['asteroid_5', 'sprite'],
  'background/background_deep_space_with_scattered_stars': ['bg_1', 'scene'],
  'background/background_purple_nebula_clouds_in_space': ['bg_2', 'scene'],
  'background/background_ringed_planet_and_moon_in_space': ['bg_3', 'scene'],
  'background/background_distant_asteroid_belt_in_space': ['bg_4', 'scene'],
  'background/background_distant_spiral_galaxy_in_space': ['bg_5', 'scene'],
}

// The picked candidates are 4-ship / 3-ship sheets; the person chose one ship in the sheet (QA rework), so it is cut out
// here (pixels of the 1024px candidate: left, top, width, height) before background removal. Keyed by the picked file.
const CROPS = {
  'player/player_spaceship_standard_flight_v20.png': { left: 30, top: 245, width: 960, height: 250 },
  'enemy/enemy_spaceship_pursuit_v5.png': { left: 95, top: 615, width: 850, height: 260 },
}

const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {}
// Already-integrated picks are skipped: promoting them again changes nothing and would reopen a completed asset.
const picks = Object.entries(state.assets || {}).filter(([k, v]) => v.pick && TARGETS[k] && !(v.integratedKey && v.integratedKey === keptKey(v)))
if (!picks.length) { console.log('[promote] nothing to integrate - choose versions in spec-web > Assets > Images (already integrated assets are skipped)'); process.exit(0) }

fs.mkdirSync(outDir, { recursive: true })
for (const kind of ['sprite', 'scene']) {
  const stage = path.join(here, 'data', `.promote-${kind}`)
  fs.rmSync(stage, { recursive: true, force: true }); fs.mkdirSync(stage, { recursive: true })
  const mine = picks.filter(([k]) => TARGETS[k][1] === kind)
  for (const [k, v] of mine) {
    const dest = path.join(stage, `${TARGETS[k][0]}.png`)
    if (CROPS[v.pick] && !dry) await sharp(path.join(dataDir, v.pick)).extract(CROPS[v.pick]).toFile(dest)
    else fs.copyFileSync(path.join(dataDir, v.pick), dest)
  }
  if (!mine.length) continue
  console.log(`[promote] ${kind}: ${mine.map(([k]) => TARGETS[k][0]).join(', ')}`)
  if (dry) continue
  const args = ['postprocess.mjs', '--in', stage, '--out', outDir]
  args.push(...(kind === 'sprite' ? ['--size', '512'] : ['--no-remove-bg', '--size', '1280', '--quality', '82']))
  const r = spawnSync('node', args, { cwd: here, stdio: 'inherit' })
  fs.rmSync(stage, { recursive: true, force: true })
  if (r.status !== 0) process.exit(r.status || 1)
}
if (!dry) {
  const r = spawnSync('npm', ['run', 'gen:assets'], { cwd: repo, stdio: 'inherit', shell: true })
  if (r.status) process.exit(r.status)
  // The files are in the game now: record it, so the Images tab shows "integrated" and enables Complete.
  const done = await markIntegrated(picks.map(([k]) => k))
  await writeSelectionManifest()
  console.log(`[promote] marked integrated: ${done.join(', ') || 'none'}`)
}
