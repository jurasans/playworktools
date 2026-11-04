/**
 * Static catalog for the spec-web "Audio" tab (S-235): every bundled sound
 * (SFX + one music loop per game) with its human-readable activation details and
 * the e2e device-matrix screenshots (if any) that show the moment it plays.
 *
 * Source of truth for the trigger text is CLAUDE.md's "Sound & Music (S-29)"
 * section (the "Effect trigger points" table + the background-music notes).
 * If a trigger changes there, update the entry here too — this file is a
 * hand-maintained mirror, deliberately not parsed out of CLAUDE.md.
 * `request` ({ wi, note }) marks a sound a work item still needs from a person; the card shows it as an open request.
 *
 * Fields
 *   name        file stem — matches public/audio/<kind>/<name>.mp3 and the
 *               SoundEffectName / GameName it plays for.
 *   kind        'sfx' | 'music'
 *   title       short human label.
 *   triggers    where/when it fires (one bullet each).
 *   screens     zero or more screenshots that show the relevant moment.
 *               Each is { screen, device?, orientation?, note? } where `screen`
 *               is the name part of an e2e-artifacts file
 *               (`<NN>-<screen>.png`, e.g. 'game-playing'). The server picks
 *               the NEWEST matching file (the numeric prefix drifts between
 *               suite runs, so it is never hard-coded) — in the preferred
 *               device/orientation when given, else the first device that has
 *               it. An empty list means "no captured screen is relevant".
 *   promptDesc  fallback generation description (used by
 *               tools/generate/audio-gen-runner.mjs only when the sound has no line
 *               in tools/generate/vars/sfx-*.txt).
 *   seconds     fallback clip length for the same purpose.
 */

const GAME_LAND = { device: 'galaxy-s25', orientation: 'landscape' }
const TEST_PORT = { device: 'galaxy-s25', orientation: 'portrait' }

export const CATALOG = [
  // ── SFX (public/audio/sfx) ────────────────────────────────────────────────
  {
    name: 'pickup', kind: 'sfx', title: 'Pickup / hit',
    triggers: [
      'Asteroid: coin collected (also a clean pass by an enemy ship, S-181)',
      'Roll the Ball: monster squished',
      'Shoot the Bottle: bottle hit',
      'Car Ride: coin collected',
      'Dart Hit: bonus (apple) object hit',
      'Matching Game: card selected',
      'Space Chase: Golden Star collected',
    ],
    screens: [{ screen: 'game-playing', ...GAME_LAND, note: 'Asteroid mid-game (only game the matrix captures)' }],
    promptDesc: 'bright ascending 8-bit chiptune coin blip, retro arcade synth sparkle, positive reward', seconds: 1.0,
  },
  {
    name: 'stuck', kind: 'sfx', title: 'Stuck / blocked',
    triggers: [
      'Asteroid: ship stuck (squeeze-fail transition)',
      'Dart Hit: dart-vs-dart collision (a life is lost)',
    ],
    screens: [{ screen: 'game-playing', ...GAME_LAND, note: 'Asteroid mid-game' }],
    promptDesc: 'low analog synth buzz alert, muffled retro error blip, blocked negative tone', seconds: 1.0,
  },
  {
    name: 'game_start', kind: 'sfx', title: 'Game start',
    triggers: ['GameHost phase enters "playing" (right after the countdown finishes)'],
    screens: [{ screen: 'game-playing', ...GAME_LAND }],
    promptDesc: 'rising synthwave power-up whoosh, futuristic arpeggio start-up chime', seconds: 1.2,
  },
  {
    name: 'game_over', kind: 'sfx', title: 'Game over',
    triggers: ['GameOverOverlay, once the real best-score query settles and the score is NOT a new personal best'],
    screens: [],
    promptDesc: 'triumphant ascending synth fanfare, bright retro arcade victory chime, upbeat major-key flourish, celebratory, festive', seconds: 1.8,
  },
  {
    name: 'record_broken', kind: 'sfx', title: 'New record',
    triggers: ['GameOverOverlay, once the best-score query settles and the score IS a new personal best'],
    screens: [],
    promptDesc: 'triumphant retro synth fanfare, rising chiptune arpeggio, celebratory laser sparkle', seconds: 1.5,
  },
  {
    name: 'calibration_success', kind: 'sfx', title: 'Calibration success',
    triggers: ['SensorStatusWidget "Set Zero & Start" / Reset Zero button, calibration-overlay branch only'],
    screens: [],
    promptDesc: 'gentle analog synth confirmation blip, soft retro success chime, calm positive', seconds: 1.0,
  },
  {
    name: 'countdown_tick', kind: 'sfx', title: 'Countdown tick',
    triggers: [
      'CountdownOverlay: each "3", "2", "1" beat before a game',
      'TestScreen: its own inline pre-test countdown (each "3", "2", "1" beat)',
    ],
    screens: [
      { screen: 'game-countdown', ...GAME_LAND, note: 'game countdown' },
      { screen: 'test-pregame-countdown', ...TEST_PORT, note: 'strength-test countdown' },
    ],
    promptDesc: 'short countdown beep tick, neutral clock tick, crisp', seconds: 1.0,
  },
  {
    name: 'countdown_go', kind: 'sfx', title: 'Countdown GO!',
    triggers: [
      'CountdownOverlay: the final "GO!" beat before a game',
      'TestScreen: the final "GO!" beat of its inline countdown',
    ],
    screens: [
      { screen: 'game-countdown', ...GAME_LAND, note: 'game countdown' },
      { screen: 'test-pregame-countdown', ...TEST_PORT, note: 'strength-test countdown' },
    ],
    promptDesc: 'energetic go start beep, higher pitched, punchy positive', seconds: 1.0,
  },
  {
    name: 'level_up', kind: 'sfx', title: 'Level up',
    triggers: [
      'Asteroid / Roll the Ball / Car Ride: level-up (with the 1200 ms freeze + "LEVEL X" overlay)',
      'Memory Cards: board cleared -> next level',
      'Dart Hit: level complete',
      'Matching Game: screen complete',
    ],
    screens: [{ screen: 'game-playing', ...GAME_LAND, note: 'approximate: shows the LVL HUD, not the level-up overlay itself' }],
    promptDesc: 'triumphant level up fanfare, ascending chime, rising melodic tones, bright', seconds: 1.8,
  },
  {
    name: 'ship_shrink', kind: 'sfx', title: 'Ship shrink',
    triggers: ['Asteroid: pressure crosses the squeeze threshold -> ship shrinks (fires once per transition)'],
    screens: [{ screen: 'game-playing', ...GAME_LAND }],
    promptDesc: 'quick retro synth downward sweep, shrinking whoosh, analog pitch drop', seconds: 1.0,
  },
  {
    name: 'ship_expand', kind: 'sfx', title: 'Ship expand',
    triggers: ['Asteroid: pressure released back below the threshold -> ship returns to full size (once per transition)'],
    screens: [{ screen: 'game-playing', ...GAME_LAND }],
    promptDesc: 'quick retro synth upward sweep, expanding whoosh, analog pitch rise', seconds: 1.0,
  },
  {
    name: 'cannon_powerup', kind: 'sfx', title: 'Cannon power-up',
    triggers: ['Shoot the Bottle: pressure crosses the threshold, cannon arms and starts charging'],
    screens: [],
    promptDesc: 'rising retro synth charge-up hum, building energy whine, analog power surge', seconds: 1.5,
  },
  {
    name: 'cannon_fire', kind: 'sfx', title: 'Cannon fire',
    triggers: [
      'Shoot the Bottle: a shot fires (auto-fire at 100% power, or release-fire)',
      'Dart Hit: reused as the dart-launch cue',
    ],
    screens: [],
    promptDesc: 'punchy retro synth laser cannon blast, sci-fi shot, analog boom', seconds: 1.2,
  },
  {
    name: 'car_crash', kind: 'sfx', title: 'Car crash',
    triggers: [
      'Car Ride: obstacle collision (replaces the generic "stuck" cue for this game)',
      'Asteroid: enemy-ship collision (S-181, -50% score)',
    ],
    screens: [],
    promptDesc: 'retro synth crash impact, harsh analog distortion hit, blocked collision thud', seconds: 1.2,
  },
  {
    name: 'test_transition', kind: 'sfx', title: 'Test round transition',
    triggers: [
      'Strength test: press -> rest transition (every round)',
      'Strength test: rest -> press transition for round 2+ (round 1 starts with countdown_go instead)',
      'Pre-Game tests are 1 round only, so this only fires for Clinical tests with 2+ rounds',
    ],
    screens: [{ screen: 'test-clinical-pressing', ...TEST_PORT, note: 'Clinical test, pressing round' }],
    promptDesc: 'short neutral retro synth transition chime, soft two-note blip, calm', seconds: 1.0,
  },
  {
    name: 'test_complete', kind: 'sfx', title: 'Test complete',
    triggers: ['Strength test: final round finishes and the phase enters "completed" (Pre-Game and Clinical)'],
    screens: [{ screen: 'test-clinical-completed', ...TEST_PORT, note: 'Test Completed popup' }],
    promptDesc: 'short positive retro synth completion jingle, bright rising two-note chime', seconds: 1.5,
  },

  {
    name: 'space_asteroid_fault', kind: 'sfx', title: 'Space Chase — asteroid fault',
    triggers: ['Space Chase: the ship hits an asteroid (FAULT); a different cue from the enemy fault so the player hears which one it was'],
    screens: [],
    request: { wi: 'WI-2', note: 'Placeholder: the live file is currently a copy of `car_crash`. Generate options and pick its own sound.' },
    promptDesc: 'short dull rocky impact thud with a falling synth sting, sci-fi collision, negative but not harsh', seconds: 1.0,
  },
  {
    name: 'space_enemy_fault', kind: 'sfx', title: 'Space Chase — enemy fault',
    triggers: ['Space Chase: the enemy catches the ship (FAULT), distinct from the asteroid fault'],
    screens: [],
    request: { wi: 'WI-2', note: 'Placeholder: the live file is currently a copy of `stuck`. Generate options and pick its own sound.' },
    promptDesc: 'low menacing synth growl swoop that ends in a short zap, sci-fi enemy caught you, negative but not harsh', seconds: 1.0,
  },
  {
    name: 'space_stage_complete', kind: 'sfx', title: 'Space Chase — stage complete',
    triggers: ['Space Chase: the stage hold finished (the player held the target long enough)'],
    screens: [],
    request: { wi: 'WI-2', note: 'Placeholder: the live file is currently a copy of `level_up`. Generate options and pick its own sound.' },
    promptDesc: 'bright rising synth arpeggio with a soft sparkle at the end, sci-fi success chime, positive and calm', seconds: 1.5,
  },
  {
    name: 'space_rest_start', kind: 'sfx', title: 'Space Chase — rest starts',
    triggers: ['Space Chase: cue just before the rest period begins (fires 0.8 s into the rest phase)'],
    screens: [],
    request: { wi: 'WI-2', note: 'Placeholder: the live file is currently a copy of `test_transition`. Generate options and pick its own sound.' },
    promptDesc: 'soft descending two-note synth chime, gentle relaxing sci-fi cue, calm', seconds: 1.0,
  },

  // ── Music (public/audio/music) — one looping bed per game ────────────────
  ...[
    ['asteroid', 'Asteroid', 'space tunnel flight, floating spacey pads, steady soft pulse', true],
    ['rolltheball', 'Roll the Ball', 'playful light rolling rhythm, bouncy warm mallets', false],
    ['shootthebottle', 'Shoot the Bottle', 'upbeat carnival shooting-gallery groove, light percussion', false],
    ['carride', 'Car Ride', 'cheerful road-trip drive, steady driving beat, bright guitar-like synth', false],
    ['memorycards', 'Memory Cards', 'calm curious thinking music, gentle plucks, soft focus', false],
    ['darthit', 'Dart Hit', 'tense rhythmic knife-throwing timing groove, wooden percussion', false],
    ['matchinggame', 'Matching Game', 'light puzzle-solving loop, friendly bells, relaxed', false],
    ['twoballpanels', 'Two-Ball Sensors (two-ball game, behind the VITE_TWO_BALL_GAMES flag)', 'two players, calm playful panels, light steady rhythm, warm mallets', false],
    ['tugofwar', 'Tug of War (two-ball game, behind the VITE_TWO_BALL_GAMES flag)', 'energetic tug-of-war rhythm, driving percussion, rising tension, friendly', false],
    ['bilateral', 'Bilateral Training (two-ball game, behind the VITE_TWO_BALL_GAMES flag)', 'balanced symmetrical flowing groove, calm focused, gentle left-right pulse', false],
    ['teamrocket', 'Team Rocket (two-ball game, behind the VITE_TWO_BALL_GAMES flag)', 'cooperative space launch, building pads and pulse, hopeful, teamwork', false],
    ['spacechase', 'Space Chase', 'calm modern space-arcade drift, soft synth pads, gentle steady pulse, not frantic', false],
  ].map(([name, game, promptDesc, hasShot]) => ({
    name, kind: 'music', title: `${game} — background music`,
    triggers: [
      `Loops during the "playing" phase of ${game} (starts alongside game_start; stops on game over or when GameHost unmounts)`,
      'Games only — never menus/login. Sensor Panel "Music" toggle mutes/unmutes it live; defaults OFF (pre-launch migration)',
    ],
    screens: hasShot ? [{ screen: 'game-playing', ...GAME_LAND, note: 'Asteroid mid-game' }] : [],
    request: name === 'spacechase' ? { wi: 'WI-2', note: 'Background music for Space Chase (S-307): review the generated candidates, Keep one and Complete it so it is promoted.' } : null,
    promptDesc: `${promptDesc}, smooth warm high-fidelity background loop, no vocals`, seconds: 12,
  })),
]

export const CATALOG_BY_NAME = new Map(CATALOG.map((c) => [c.name, c]))
