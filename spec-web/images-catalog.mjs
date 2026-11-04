/**
 * Static catalog for the spec-web "Images" tab: every Space Chase art asset with where the game uses it, so a reviewer
 * judging candidates knows what the picture has to do. Mirrors docs/spec/games.md -> Space Chase and src/games/spacechase.
 *
 *   asset    '<group>/<key>' — the folder and file stem under tools/generate/data/spacechase (key = slug of `subject`)
 *   subject  the words spacechase-art.mjs puts in the prompt for this asset (a single-asset job regenerates by this text)
 *   file     the name the game loads from public/images/spacechase once a pick is promoted
 */
const SHIP_NOTE = 'Side profile, nose pointing right; the game flips nothing, so a wrong direction is a reject.'
const ROCK = ['Hazard in every stage; five shapes alternate along the field.', 'Muted gray-blue and purple.']
const SPACE_ONLY = 'Space only (no ground, no horizon); must tile horizontally.'

const entry = (group, subject, title, file, triggers) => ({
  asset: `${group}/${subject.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
  group, subject, title, file, triggers,
})

export const IMAGE_CATALOG = [
  entry('player', 'player spaceship standard flight', 'Player ship', 'ship.webp', [
    'The friendly ship the patient flies: its engine flame is drawn in code and grows with speed.',
    'Turquoise and soft blue, clearly different from the enemy. ' + SHIP_NOTE,
  ]),
  entry('enemy', 'enemy spaceship pursuit', 'Enemy ship', 'enemy.webp', [
    'Trails the player and closes in only while Force is below threshold; it never fires. Its flame is drawn in code and grows as it closes in.',
    'Slightly larger, muted orange/red, not frightening. ' + SHIP_NOTE,
  ]),
  entry('asteroid', 'asteroid round smooth', 'Asteroid: round, smooth', 'asteroid_1.webp', ROCK),
  entry('asteroid', 'asteroid jagged angular', 'Asteroid: jagged, angular', 'asteroid_2.webp', ROCK),
  entry('asteroid', 'asteroid long oval', 'Asteroid: long oval', 'asteroid_3.webp', ROCK),
  entry('asteroid', 'asteroid cratered large', 'Asteroid: cratered, large', 'asteroid_4.webp', ROCK),
  entry('asteroid', 'asteroid small chunky', 'Asteroid: small, chunky', 'asteroid_5.webp', ROCK),
  entry('background', 'background deep space with scattered stars', 'Background 1: starfield', 'bg_1.webp', ['Stages 1-2. Dark-blue starfield, scrolls with parallax behind the ship.', SPACE_ONLY]),
  entry('background', 'background purple nebula clouds in space', 'Background 2: nebula', 'bg_2.webp', ['Stages 3-4. Planets and nebulae.', SPACE_ONLY]),
  entry('background', 'background ringed planet and moon in space', 'Background 3: ringed planet', 'bg_3.webp', ['Stages 5-6. Ringed planet and moon.', SPACE_ONLY]),
  entry('background', 'background distant asteroid belt in space', 'Background 4: asteroid belt', 'bg_4.webp', ['Stages 7-8. Distant purple asteroid belt.', SPACE_ONLY]),
  entry('background', 'background distant spiral galaxy in space', 'Background 5: spiral galaxy', 'bg_5.webp', ['Stages 9-10. Distant turquoise/dark-blue galaxy.', SPACE_ONLY]),
]

export const CATALOG_BY_ASSET = new Map(IMAGE_CATALOG.map((e) => [e.asset, e]))
