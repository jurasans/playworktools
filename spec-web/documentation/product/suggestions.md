# The Forward Register

*Playwork · Product proposals · 31 August 2026 (Game Concepts added 30 September 2026)*

Forty proposals for the next chapters of Playwork — ten that sharpen what already ships, ten that add genuinely new capability, ten that are deliberately, uncomfortably large, and ten new games built on what the sensor already streams and nothing has ever read.

The app is unusually complete for its stage. Seven games, two test catalogues, a full trainer panel, six languages, encrypted local storage, consent-gated telemetry, and a spec registry over two hundred items deep. What it does not yet have is a second act — a reason the clinic that bought one ball buys twelve, and a reason an investor believes the ceiling is higher than the number of physiotherapy rooms within driving distance.

Everything below names what it builds on inside the existing codebase, so a promising item can be lifted straight into the stub registry without re-derivation. The first three tiers escalate deliberately: **Refine** is work that could start Monday, **Expand** is work that needs a sprint and a decision, **Moonshot** is work that changes what company this is.

The fourth tier is a different axis entirely. Every shipped game and test reduces the sensor to two channels — squeeze pressure, and rotation read as an absolute held position. `facade.acceleration$` has been emitted, typed and plumbed through every backend since the beginning and no engine has ever subscribed to it; nothing has ever taken the first derivative of rotation to read it as speed rather than position, either. **Game Concepts** is ten ideas built specifically on that gap — some replace pressure and rotation entirely, some layer a new channel onto a mechanic that already ships.

## Tier one · Refine — Ten improvements to features that already ship

Each of these sits on top of code that already exists and data you are already collecting. None require new hardware, a backend, or a regulatory conversation. Most are one sprint or less.

### R-01 — Adaptive difficulty inside the session

Difficulty is set once, before play, from a preset and a strength test. Let the engine nudge squeeze threshold and tilt range within trainer-defined bounds while the round runs, keyed to live miss rate and time-in-zone — the same signals already feeding movement accuracy and success rate.

**Why:** A patient who fatigues mid-session currently just fails repeatedly. Staying in the productive band produces far more therapeutic dose per minute of attention.

`Builds on: presets, idle baseline` · `Effort: M` · **Lift: clinical efficacy**

### R-02 — Prescription mode on the home screen

Replace the free game menu with "Today's session" whenever a trainer has set a weekly plan: three named exercises, in order, settings already applied, free choice behind a toggle. The storage this needs — settings per client per game — is already there.

**Why:** Removes the largest source of home-use drift: the patient choosing the game they enjoy rather than the one their shoulder needs.

`Builds on: GameSettings, Home` · `Effort: M` · **Lift: adherence**

### R-03 — A report the patient can take home

The Print button was removed and never replaced. Render the Progress Report to a self-contained file and save it through the same Filesystem path the CSV export already uses, then hand it to the OS share sheet.

**Why:** Trainers can export raw CSV for themselves but have nothing to give a patient, a referring physician, or an insurer. This is the artefact that leaves the building and sells the next unit.

`Builds on: CSV export path` · `Effort: M` · **Lift: word of mouth**

### R-04 — Test quality flags

You retain the full 20 Hz trace of every strength test and never interrogate it. Flag a result as low-confidence when the peak lands in the final half second (the patient was still climbing when the round ended), when the baseline drifts mid-test, or when the ramp is truncated.

**Why:** Every game threshold in the app derives from these numbers. One bad test silently miscalibrates weeks of training and nothing currently notices.

`Builds on: TestResult time series` · `Effort: S` · **Lift: data integrity**

### R-05 — Limb symmetry index

Every test is now keyed to extremity *and* side. Compute the ratio between them and surface it as a single number with a target band, on the test summary and in the Progress Report.

**Why:** Symmetry is the figure clinicians actually make return-to-activity decisions on. You are one division away from producing the most clinically fluent output in the whole app.

`Builds on: per-side test identity` · `Effort: S` · **Lift: clinical credibility**

### R-06 — Session replay for the trainer

Record a compact telemetry track during games — pressure and rotation at 10 Hz plus scoring events — and give the trainer a scrubber over it in the results row. Tests already store their traces; games discard everything but the score.

**Why:** A score of 320 says nothing about *why*. A replay showing the patient losing the ring on every left-hand turn says what to work on tomorrow.

`Builds on: GameResult, test-trace precedent` · `Effort: L` · **Lift: trainer value**

### R-07 — A sensor health card

Retain what already streams past you: battery over time, disconnects per session, scan signal strength, cumulative hours, first-seen date. Show it in the About dialog as a short history rather than one instantaneous reading.

**Why:** Turns "the ball feels weird lately" into a number a support conversation can start from — and gives you the first real field-reliability dataset for the hardware.

`Builds on: battery stream, sensor pill` · `Effort: M` · **Lift: support cost**

### R-08 — Search, sort and archive in the user list

The Users tab is create-edit-delete only. A scroll list stops working around fifteen people. Add search, sort by last session, and an archive state that hides a discharged patient without destroying their history.

**Why:** The licence tiers explicitly sell fifty users. The interface currently makes fifty users unpleasant.

`Builds on: Users tab` · `Effort: S` · **Lift: usability at scale**

### R-09 — A translation coverage gate

The string-file test already catches malformed rows. Extend it to catch the quieter failure: a non-English cell identical to its English cell, an untranslated clinical term, a language drifting out of coverage as new keys land. Report per-language completeness on every run.

**Why:** Two open items already ask for a translation review and two new languages. A gate turns that from a recurring manual audit into a build-time fact.

`Builds on: strings integrity test` · `Effort: S` · **Lift: market readiness**

### R-10 — A sixty-second first run

Pair the ball, create a user, take one baseline test, start one game — guided, once, on first launch of a new device. Every step already exists; nothing sequences them.

**Why:** The feature surface is deep and most of it hides behind a status pill. A guided first run is the cheapest available reduction in onboarding calls and the fastest route to a clinic's first successful session.

`Builds on: connect flow, funnel` · `Effort: M` · **Lift: activation**

## Tier two · Expand — Ten new capabilities worth a sprint each

These add something the product cannot currently do. Each needs a real decision before it starts — about scope, about hardware, or about where clinical data is allowed to live — but none of them changes the shape of the business.

### X-01 — Clinic sync over the local network

Three tablets in one clinic hold three unrelated patient rosters. A small local hub — one device elected as source of truth, peers syncing over the LAN — would share clients and history without a byte leaving the building.

**Why:** Preserves the offline-first promise exactly while removing the most common complaint of any multi-room clinic. It is also the groundwork for anything cloud-shaped later.

`Effort: L` · `Needs: sync design, conflict rules` · **Lift: multi-unit sales**

### X-02 — Two balls, one screen

Head to head: patient against therapist, or patient against patient, split screen, two connected sensors. The facade already models discovery and connection generically; the constraint today is one *active* connection, not one possible one.

**Why:** Competition is the strongest adherence lever in rehabilitation gaming and the product currently has none of it. It is also a clean reason for a clinic to own a second ball.

`Effort: L` · `Needs: multi-connection facade` · **Lift: engagement, unit sales**

### X-03 — Bilateral training

One ball in each hand, both streaming. Mirror tasks, alternating tasks, and coordination tasks where the affected side has to track the unaffected one.

**Why:** Bilateral and mirror training carry real evidence in stroke rehabilitation, and they are exercises no single-sensor competitor can offer. A clinically defensible reason to sell a pair.

`Effort: L` · `Needs: X-02 first` · **Lift: new indication**

### X-04 — Range-of-motion measurement

The sensors already emit absolute orientation. A guided wrist or forearm sweep, recorded and charted over time, is an entirely new clinical measure requiring no new hardware and no new firmware — only a screen and a formula.

**Why:** Today the product measures force. Adding range doubles what a clinician can chart, and range is often the outcome that moves first in early rehabilitation.

`Effort: M` · `Needs: protocol validation` · **Lift: new measure**

### X-05 — An endurance test beside the max test

Hold at a set fraction of your own maximum for as long as you can. Record time to failure and the shape of the decline. Same screen, same sensor, different instruction.

**Why:** Peak force and endurance are different deficits with different treatments. Measuring only peak leaves half of what the ball can see invisible to the clinician.

`Effort: M` · `Needs: protocol design` · **Lift: new measure**

### X-06 — Cognitive-motor dual task

Layer the matching game over a sustained squeeze target: the patient must hold force inside a band while solving the board. Score both, and score the interference between them.

**Why:** Dual-task performance is an established marker in Parkinson's, stroke and fall-risk assessment. It reaches a new clinical audience using games you have already built.

`Effort: M` · `Needs: scoring model` · **Lift: new audience**

### X-07 — Prescription handoff by QR

The trainer builds a programme in the clinic and generates a code. The patient's home tablet scans it and receives the whole plan — games, settings, schedule, target — with no account, no server and no network.

**Why:** Solves clinic-to-home transfer without breaking the offline architecture or opening a single privacy question. The cheapest possible bridge to home use.

`Effort: M` · `Needs: encoding format` · **Lift: home channel**

### X-08 — Eyes-off sessions

An audio-led mode: spoken instruction, tonal feedback for force and direction, no reliance on reading the screen. The sound system, the cue vocabulary and the phase machine already exist.

**Why:** Opens the product to low-vision patients and to anyone whose neck or posture makes screen-watching part of the problem — and it advances the accessibility work already queued.

`Effort: M` · `Needs: audio design` · **Lift: accessibility**

### X-09 — Goals, streaks, and a reason to come back tomorrow

Trainer-set weekly targets, a visible streak, and a small celebration when a personal record falls. Everything needed is already recorded; nothing currently rewards it.

**Why:** Non-adherence, not lack of efficacy, is what kills home rehabilitation programmes. The retention mechanics consumer fitness apps take for granted are the cheapest intervention available, and the product has none of them.

`Effort: M` · `Needs: tone calibration` · **Lift: retention**

### X-10 — A clinic view above the patient view

One screen for the clinic owner rather than the treating therapist: caseload, sessions delivered this week, patients trending down, devices sitting idle. Built initially from the exports you already produce.

**Why:** The person who signs the purchase order is not the person using the app. This is the first screen built for them, and it makes renewal a conversation about value rather than cost.

`Effort: L` · `Needs: aggregation source` · **Lift: renewal**

## Tier three · Moonshot — Ten deliberately enormous bets

Not sprint items. Each is a multi-year commitment that would change what Playwork is, what it charges for, and who it competes with. Several reinforce each other; several are mutually exclusive. Each carries the condition that has to hold for it to be worth starting.

### M-01 — The outcomes registry

Consented, de-identified results from every device, pooled into a normative database. Then the app can say: *this patient's grip sits at the 34th percentile for women aged 60 to 65 at eight weeks post-operative, and the trajectory is above median.*

**Why:** Normative data is the defensible asset in this entire category. Anyone can build a squeezable ball; nobody can rebuild ten years of recovery curves. It is simultaneously the moat, the clinical credibility and the investor narrative.

`Effort: XL` · `Needs: cloud, consent, ethics review` · **Has to be true: clinics accept opt-in pooling**

### M-02 — Clearance as a measuring device

Pursue regulatory clearance for the strength and range measurements as a medical measuring instrument — not as therapy, as *measurement*, which is the narrower and far more achievable claim.

**Why:** It is the difference between a motivating toy and an instrument whose numbers may be entered into a medical record. Clearance is the precondition for most of what follows, and every quarter it waits it gets no cheaper.

`Effort: XL` · `Needs: quality system, validation study` · **Has to be true: accuracy survives audit**

### M-03 — Getting paid by the payer, not the clinic

Remote therapeutic monitoring is a reimbursable category in several markets. Build the adherence evidence, the monitoring log and the clinician review workflow a claim actually requires, and the device is billed monthly rather than bought once.

**Why:** The single largest change available to the business model. It converts a one-off hardware sale into recurring revenue per patient per month, and it makes the clinic's purchase profitable rather than discretionary.

`Effort: XL` · `Needs: M-02, market-by-market billing work` · **Has to be true: a viable code exists where you sell**

### M-04 — Recovery forecasting

Train on the registry to answer the question every patient asks and no clinician can currently answer with data: *how long until I am back?* Then flag, early, the patients whose curve has flattened below the expected path.

**Why:** Prediction turns a measurement tool into a decision tool. Catching a stalling recovery three weeks sooner is worth more — clinically and economically — than any game mechanic on this page.

`Effort: XL` · `Needs: M-01 at volume` · **Has to be true: enough labelled outcomes to model**

### M-05 — Open the ball to other developers

Publish the sensor as a documented controller with an SDK and let third parties build therapy games, research protocols and school applications on it. Curate a catalogue; take a share of it.

**Why:** You will never build the seventieth game yourself. A platform lets the market discover indications you would never have targeted — and every third-party title sold is another reason to buy the hardware.

`Effort: XL` · `Needs: stable protocol, review process` · **Has to be true: an installed base worth building for**

### M-06 — A portable score for physical function

One composite index — force, endurance, control, symmetry, range — normalised against the registry and expressed as a single number a person can watch move. Portable between clinics, comparable across years, owned by the patient.

**Why:** A number people track is a number people return to. It is also the most legible thing you could put in front of an insurer, an employer, a sports club or a journalist.

`Effort: XL` · `Needs: M-01, validation, naming` · **Has to be true: the index predicts something real**

### M-07 — Seeing the compensation

Add the tablet camera to the sensor stream. Pose estimation catches the shoulder hitching, the trunk leaning in, the wrist substituting for the elbow — the compensations that make a good score clinically worthless — and the app corrects them in the moment.

**Why:** This is what a human therapist provides that no home device does. Solving it is what makes unsupervised rehabilitation genuinely safe rather than merely convenient.

`Effort: XL` · `Needs: on-device vision, clinical validation` · **Has to be true: pose accuracy holds in a real room**

### M-08 — The session runs itself

An autonomous session director: it picks today's exercises from the plan and yesterday's performance, sets the difficulty, coaches through the round, decides when to stop, and writes the note the therapist reviews in ninety seconds.

**Why:** A therapist supervising ten concurrent patients instead of one changes clinic economics outright — and it is the only credible answer to the workforce shortage every health system is currently facing.

`Effort: XL` · `Needs: M-04, M-07, liability model` · **Has to be true: clinicians will delegate the session**

### M-09 — Leave the clinic entirely

A consumer product on the same ball: a narrative world for children with motor delay, for neurodivergent kids, for anyone building hand strength who has never met a physiotherapist. Sold in boxes, subscribed to monthly, marketed to parents.

**Why:** Clinical sales are slow, referenced and geographically bounded. A consumer channel is the only route to a market measured in millions rather than in rooms — and it funds the clinical work.

`Effort: XL` · `Needs: separate brand, retail, content pipeline` · **Has to be true: parents buy without a prescription**

### M-10 — A marketplace for supervision

The patient has a ball and no local physiotherapist. Match them with a licensed remote one who sees their data continuously rather than in a fifteen-minute appointment, and reviews asynchronously. Take a margin on every session.

**Why:** It converts a device company into a care network with platform economics, and it serves the enormous population — rural, elderly, uninsured, recently discharged — for whom the alternative is no rehabilitation at all.

`Effort: XL` · `Needs: licensing per jurisdiction, clinician supply` · **Has to be true: remote practice is permitted where you sell**

## Tier four · Game Concepts — Ten games built on what the sensor streams and nothing reads

Not an escalation like the tiers above — a different axis. Every one of the seven shipped games reduces the ball to two channels: squeeze pressure, and rotation read as a held position. `facade.acceleration$` is emitted by every backend and read by nothing. Rotation has never been differentiated into a speed. These ten are built specifically on that gap — some replace pressure and rotation outright, some layer a new channel onto a mechanic that already ships.

### G-01 — Shake Rally

Rhythmically shaking the ball keeps an on-screen flame lit; it dims the moment `acceleration.magnitude` drops below a rolling baseline for more than a beat. No squeeze threshold, no rotation tracking at all — the first game built on a channel every engine already receives but none subscribes to.

**Why:** Opens the product to patients who can produce a controlled shake but struggle to sustain a squeeze or hold a precise tilt — a ballistic wrist flexion/extension pattern none of the current seven games ask for, since all seven gate on pressure.

`Uses: acceleration magnitude only` · `Effort: S` · `Needs: new engine, no new sensor code` · **Lift: new motor pattern, accessibility**

### G-02 — Flick Race

A lane-racer whose speed comes from how *fast* the ball is rotated, not how far. Every engine already computes rotation as an absolute position (`RotationAxisController.compute()`); this is the first to differentiate it client-side into degrees/second and steer off the sign and size of that derivative instead.

**Why:** Every rotation-driven game today rewards a held position — Table/Wall calibration, Reset Zero. A speed-based game targets explosive, ballistic range instead of sustained control: a genuinely different rehab goal, using zero new hardware or firmware, just a derivative nobody has written yet.

`Uses: rotation angular velocity` · `Effort: M` · `Needs: new derivative helper in sensorMode.ts` · **Lift: new motor pattern**

### G-03 — Tap & Catch

Objects fall from the top of the screen; a quick tap of the ball against a palm or tabletop — a sharp, short spike in `acceleration.magnitude` — is the "catch," timed like a rhythm game, instead of crossing and holding a squeeze threshold.

**Why:** Squeeze-threshold gating assumes a patient can reliably produce and hold a target force. A tap is a single ballistic event many patients who cannot sustain a squeeze can still produce — a second input vocabulary the product doesn't have today.

`Uses: acceleration spike detection` · `Effort: M` · `Needs: spike/debounce algorithm` · **Lift: accessibility, new input vocabulary**

### G-04 — Steady Hands

The inverse of every existing game: score accrues for keeping `acceleration.magnitude` below a jitter ceiling — holding the ball as still as possible, for as long as possible. A tremor shows up immediately as a falling score, instead of being invisible the way it is in every pressure/rotation-only game today.

**Why:** Static stability and tremor are real, common assessment targets the product currently has no way to even measure, let alone gamify — and the data already streams in at whatever rate the backend emits it, no new firmware required.

`Uses: acceleration magnitude, inverted` · `Effort: S` · `Needs: baseline/jitter calibration` · **Lift: new clinical target — stability/tremor**

### G-05 — Spin & Squeeze Reactor

Spinning the ball charges a reactor at a rate proportional to angular velocity, not position; squeezing above threshold fires it at whatever charge has built up. Two channels working together, one of them — rotation speed — never used in any existing game.

**Why:** A genuinely new two-handed-feeling mechanic with no second sensor. Every existing dual-input game (Roll the Ball, Car Ride, Memory/Matching) pairs pressure with rotation *position*, never rotation speed — a different feel with the pressure half already written and unchanged.

`Uses: rotation angular velocity + pressure` · `Effort: M` · `Needs: G-02's derivative helper` · **Lift: new combined mechanic**

### G-06 — Punch Zones

A reflex/whack-style game where six target zones map to the six directions a quick jab-like acceleration spike can point — `AccelerationEvent.x/y/z`, not just `.magnitude` — forward, back, left, right, up, down relative to however the ball is currently held.

**Why:** Every stat this product has ever shipped reduces acceleration to a single scalar (`TestResult.maxAcceleration`) or ignores it outright. Nothing today reads x/y/z as a direction — this is the first mechanic that would.

`Uses: acceleration vector direction` · `Effort: L` · `Needs: local-axis direction classifier` · **Lift: new mechanic class — reaction/agility**

### G-07 — Squeeze Burst

Score is how fast the player ramps from baseline to peak squeeze — the derivative of pressure over a short window — not whether they crossed a threshold or how hard they pressed. Shoot the Bottle already tracks a peak-power model; this exposes the ramp *rate* itself as the scored quantity for the first time.

**Why:** Every test and every game today measures peak force or sustained-above-threshold force. Explosive/burst strength — grip-force rate of development, a standard metric in hand therapy — is a distinct target this pressure stream already supports and nothing reads today.

`Uses: pressure rate of change` · `Effort: S` · `Needs: rolling-window derivative` · **Lift: new clinical measure — explosive strength**

### G-08 — Roll & Rumble

A maraca-style rhythm game: shake the ball to a beat, scored on how closely the timing and regularity of `acceleration.magnitude` peaks matches the track's tempo, not on hitting any single target value.

**Why:** Games today reward either holding a position or crossing a level; none reward the *timing* or *regularity* of a repeated motion. Rhythmic bilateral or unilateral wrist movement is a common OT exercise with no equivalent in the current seven games.

`Uses: acceleration rhythm/periodicity` · `Effort: M` · `Needs: beat-detection + scoring model` · **Lift: new motor pattern (music licensing question)**

### G-09 — Smooth Operator

Reuses an existing mechanic — small-range tilt, already live in Roll the Ball and Car Ride — but only counts the tilt toward score while acceleration stays below a jitter ceiling. A shaky, jerky tilt stops scoring even when the rotation position is technically correct.

**Why:** The cheapest item on this page to build — one new gate layered onto a mechanic that already ships — and the first to ask for smooth, controlled movement rather than raw range or raw force: a different quality of movement than anything currently scored.

`Uses: acceleration as a smoothness gate + existing rotation` · `Effort: S` · `Needs: jitter threshold tuning` · **Lift: new clinical target, minimal build cost**

### G-10 — Quick Flip

A reflex test dressed as a game: on a visual or audio cue, flip the ball as fast as possible in the prompted direction. Scores both reaction latency — time from cue to the first detected angular-velocity spike — and the peak angular velocity reached.

**Why:** The product has grip-strength and endurance tests but nothing that measures reaction time or movement speed — a genuinely new assessment category, built entirely on a derivative this codebase has never computed before this list.

`Uses: rotation angular velocity (reaction)` · `Effort: M` · `Needs: G-02's derivative helper, cue/timing UI` · **Lift: new assessment category**

## Tier five · Conditions — Five game ideas for each condition

Fifty-five games grouped by the condition they are built for. Each uses only what the ball already measures — squeeze pressure, rotation, and acceleration — and names the clinical goal it trains. These are product ideas, not clinical claims: every one needs a clinician to confirm the exercise, dose and safety limits before it is built.

### Cerebral palsy

#### D-01 — Balloon Release

A balloon inflates while the player squeezes, then floats gently down only if the grip is let go slowly along a target curve. Fast drops pop it.

**Why:** Spasticity makes *releasing* a grip harder than making one; no current game rewards controlled release.

`Uses: pressure (release curve)` · `Effort: S` · **For: Cerebral palsy**

#### D-02 — Garden Grower

Light, sustained squeezes water a garden that grows over the session. Very low thresholds, long holds, no fail state — built for young children.

**Why:** Short attention spans and low force are the norm in paediatric CP; this gives dose without frustration.

`Uses: pressure (low, sustained)` · `Effort: S` · **For: Cerebral palsy**

#### D-03 — Two-Hand Train

Both hands hold the ball: tilt steers the train, squeeze sounds the horn. Steering only works when both hands contribute.

**Why:** Encourages the affected hand to join in, the core idea of bimanual (HABIT-style) therapy.

`Uses: rotation + pressure, bimanual` · `Effort: M` · **For: Cerebral palsy**

#### D-04 — Supination Sunrise

Turning the forearm palm-up (Wall mode yaw) raises the sun over a landscape; the higher the sun, the more the scene comes alive.

**Why:** Supination is often the most limited CP movement and nothing in the app targets it directly.

`Uses: rotation (yaw, forearm)` · `Effort: S` · **For: Cerebral palsy**

#### D-05 — Bubble Tempo

Squeeze-and-release in time with a slow beat to pop bubbles; tempo rises only when the rhythm is clean.

**Why:** Trains smooth alternation and reduces co-contraction instead of rewarding raw force.

`Uses: pressure (rhythm)` · `Effort: S` · **For: Cerebral palsy**

### Parkinson's disease

#### D-06 — Think Big

Targets only register when the player makes a *large* tilt; score scales with movement amplitude, not accuracy.

**Why:** Small, shrinking movements are the hallmark of Parkinson's; amplitude training (LSVT BIG) is the best-known answer.

`Uses: rotation amplitude` · `Effort: S` · **For: Parkinson's disease**

#### D-07 — Metronome March

A marching band moves forward on squeezes timed to an audible beat; the beat slowly fades to test self-pacing.

**Why:** External rhythmic cueing reliably improves movement in Parkinson's and is easy to measure here.

`Uses: pressure (rhythm) + audio cue` · `Effort: S` · **For: Parkinson's disease**

#### D-08 — Lantern Walk

Carry a lantern along a dark path by holding the ball as still as possible; tremor makes the flame flicker out.

**Why:** Turns tremor into a visible, logged number per session (pairs with G-04).

`Uses: acceleration (stillness)` · `Effort: S` · **For: Parkinson's disease**

#### D-09 — Traffic Lights

Squeeze on green, freeze instantly on red, release on amber. Measures time to start and time to stop.

**Why:** Trains movement initiation and stopping, the skills behind freezing episodes.

`Uses: pressure (go/no-go)` · `Effort: S` · **For: Parkinson's disease**

#### D-10 — Dial Turner

Repeated large forearm rotations open a vault; the game tracks how amplitude decays across repetitions.

**Why:** Shows the 'sequence effect' (movements shrinking with repetition) and rewards keeping them big.

`Uses: rotation (repeated yaw)` · `Effort: M` · **For: Parkinson's disease**

### ACL injury

#### D-11 — Quad Set Rocket

Ball under the knee, pushing it down into the bed (quad set) launches a rocket. Hold time sets the altitude.

**Why:** Getting the quadriceps to fire is the first goal after ACL surgery; this makes a boring exercise visible.

`Uses: pressure (under knee)` · `Effort: S` · **For: ACL injury**

#### D-12 — Knee Squeeze Keeper

Ball between the knees; timed squeeze holds block shots in a penalty shoot-out.

**Why:** Adductor isometrics are a standard early ACL exercise and need no equipment beyond the ball.

`Uses: pressure (between knees)` · `Effort: S` · **For: ACL injury**

#### D-13 — Heel Dig Kite

Lying down with the ball under the heel, pressing down flies a kite higher. Ties to the Hamstring Strength test.

**Why:** Hamstrings protect the ACL graft; this gives a playable hamstring isometric.

`Uses: pressure (under heel)` · `Effort: S` · **For: ACL injury**

#### D-14 — Symmetry Duel

Alternate presses with the injured and healthy leg; the game rewards matching force, not maximum force.

**Why:** Limb symmetry is the main return-to-sport criterion (pairs with R-05).

`Uses: pressure, left vs right` · `Effort: M` · **For: ACL injury**

#### D-15 — Slow Lowering

Ramp up to a target, then release slowly along a descending line; a fast drop breaks the bridge.

**Why:** Introduces eccentric control, which is what knees need for landing and deceleration.

`Uses: pressure (eccentric curve)` · `Effort: S` · **For: ACL injury**

### Wrist injury

#### D-16 — Wrist Compass

Tilt the wrist up, down, left and right to reach compass points that move outward as range improves.

**Why:** Measures and trains flexion/extension and radial/ulnar deviation range in one game.

`Uses: rotation (2-axis)` · `Effort: S` · **For: Wrist injury**

#### D-17 — Doorknob Dash

Turn the forearm palm-up and palm-down to open a series of doors against a timer.

**Why:** Pronation/supination is often lost after wrist fractures and is needed for daily tasks.

`Uses: rotation (yaw)` · `Effort: S` · **For: Wrist injury**

#### D-18 — Gentle Grip Ladder

Hit exact low grip levels (20%, 40%, 60%) on request; precision scores, overshooting does not.

**Why:** Protects healing tissue while rebuilding fine control of force.

`Uses: pressure (graded precision)` · `Effort: S` · **For: Wrist injury**

#### D-19 — Pour the Tea

Tilt slowly to pour tea into cups without spilling, keeping a light grip the whole time.

**Why:** Combines slow, controlled wrist movement with a functional, everyday task.

`Uses: rotation + light pressure` · `Effort: M` · **For: Wrist injury**

#### D-20 — Clock Circles

Trace circles on a clock face by tilting the wrist, both directions.

**Why:** Circumduction combines every wrist plane and is a classic home exercise.

`Uses: rotation (circular path)` · `Effort: S` · **For: Wrist injury**

### Shoulder injury

#### D-21 — Wall Painter

Ball pressed against the wall, rolling it upward paints a mural; the canvas grows as range improves.

**Why:** Wall slides are a staple of shoulder rehab; the mural shows progress in reach height.

`Uses: rotation (Wall mode) + pressure` · `Effort: M` · **For: Shoulder injury**

#### D-22 — Pendulum Ship

Hold the ball and let the arm swing (Codman pendulum); gentle, rhythmic swings rock a pirate ship.

**Why:** Early post-injury shoulders need passive, relaxed movement, not effort; this rewards relaxation.

`Uses: acceleration (rhythm)` · `Effort: S` · **For: Shoulder injury**

#### D-23 — Castle Guard

Press the ball into the wall in different directions (forward, outward, inward) and hold a target force to defend the castle.

**Why:** Isometric rotator-cuff loading is safe early and reduces pain.

`Uses: pressure (directional holds)` · `Effort: S` · **For: Shoulder injury**

#### D-24 — Rotator Arc

Elbow tucked at the side, rotate the forearm outward to guide a fish through an arc.

**Why:** External rotation is the most important and most limited cuff movement.

`Uses: rotation (yaw, ER/IR)` · `Effort: M` · **For: Shoulder injury**

#### D-25 — Reach & Hold

Reach to targets at rising heights and hold the ball steady at each for a few seconds.

**Why:** Trains shoulder-blade control at end range, where impingement problems live.

`Uses: rotation + acceleration (steadiness)` · `Effort: M` · **For: Shoulder injury**

### Ankle sprain

#### D-26 — Foot Pedal Racer

Ball under the foot: pressing down is the gas pedal of a race car. Ties to the Calf Strength test.

**Why:** Calf strength returns slowly after a sprain; this makes plantarflexion fun to repeat.

`Uses: pressure (under foot)` · `Effort: S` · **For: Ankle sprain**

#### D-27 — Ankle Alphabet

Ball under the foot, tilt the ankle to trace letters on screen.

**Why:** The 'ankle alphabet' is the most common early sprain exercise; this makes it measurable.

`Uses: rotation (2-axis, foot)` · `Effort: S` · **For: Ankle sprain**

#### D-28 — Wobble Island

Stand on one leg holding the ball to the chest; body sway keeps a small island afloat — too much sway sinks it.

**Why:** Balance (proprioception) training is what prevents repeat sprains.

`Uses: acceleration (sway)` · `Effort: M` · **For: Ankle sprain**

#### D-29 — Toe Tap Drums

Ball under the forefoot, rhythmic up-and-down taps play a drum song.

**Why:** Trains ankle dorsiflexion/plantarflexion speed and control.

`Uses: acceleration taps + pressure` · `Effort: S` · **For: Ankle sprain**

#### D-30 — Eversion Goalie

Press the outside of the foot into the ball against a wall to block shots.

**Why:** Weak evertor muscles are a major cause of re-injury and rarely get trained.

`Uses: pressure (eversion hold)` · `Effort: S` · **For: Ankle sprain**

### Autism

#### D-31 — Calm Cloud

Slow squeeze-and-release paired with a breathing animation; the cloud changes colour as breathing slows. No score, no fail state.

**Why:** Deep pressure and slow breathing support self-regulation; a calm mode the app lacks.

`Uses: pressure (slow cycles)` · `Effort: S` · **For: Autism**

#### D-32 — Pattern Builder

Squeeze to place blocks that complete a repeating colour/shape pattern, with a visible step-by-step plan.

**Why:** Predictable, structured tasks suit many autistic users and build sequencing skills.

`Uses: pressure + rotation (select)` · `Effort: M` · **For: Autism**

#### D-33 — Feelings Match

Tilt to choose the face that matches a short scene, with clear, simple illustrations.

**Why:** Practises emotion recognition in a low-pressure, game format.

`Uses: rotation (selection)` · `Effort: M` · **For: Autism**

#### D-34 — Turn-Taking Relay

Two players share one ball; the game shows whose turn it is and rewards passing on cue.

**Why:** Builds turn-taking and shared attention, core social goals.

`Uses: pressure, two players` · `Effort: M` · **For: Autism**

#### D-35 — Quiet Aquarium

Low-stimulation free play: tilt to guide fish, squeeze to feed. Sound and colour intensity are user-adjustable.

**Why:** Gives sensory-sensitive users a safe space and lets them control stimulation themselves.

`Uses: rotation + pressure` · `Effort: S` · **For: Autism**

### ADHD

#### D-36 — Wait for It

Squeeze only when the right target appears; early or wrong squeezes cost points.

**Why:** Classic go/no-go training for impulse control, with reaction data logged.

`Uses: pressure (go/no-go)` · `Effort: S` · **For: ADHD**

#### D-37 — Hold the Beam

Keep the squeeze inside a narrow band for a long stretch while rare events need a response.

**Why:** Trains sustained attention (vigilance), the hardest skill for many with ADHD.

`Uses: pressure (narrow band)` · `Effort: S` · **For: ADHD**

#### D-38 — Simon Squeeze

Repeat growing sequences of short squeezes, long squeezes and tilts.

**Why:** Working-memory training with a physical response keeps restless players engaged.

`Uses: pressure + rotation (sequence)` · `Effort: M` · **For: ADHD**

#### D-39 — Distraction Shield

A steady focus task with increasing on-screen distractions that must be ignored.

**Why:** Measures and trains resistance to distraction; difficulty adapts per session.

`Uses: pressure + rotation` · `Effort: M` · **For: ADHD**

#### D-40 — Time Keeper

Hold a squeeze for what feels like 5 seconds with no timer shown, then see how close you were.

**Why:** Time perception is often off in ADHD; this makes it visible and trainable.

`Uses: pressure (duration)` · `Effort: S` · **For: ADHD**

### Stroke

#### D-41 — Rep Quest

Each squeeze-release moves a hero one step on a long adventure; the trainer sees total reps.

**Why:** Recovery after stroke depends on hundreds of repetitions; this counts dose and keeps it fun.

`Uses: pressure (high reps)` · `Effort: S` · **For: Stroke**

#### D-42 — Searchlight

Targets appear more often on the neglected side; tilt to sweep a searchlight and find them.

**Why:** Trains attention to the neglected side and logs left/right bias over time.

`Uses: rotation (scan)` · `Effort: M` · **For: Stroke**

#### D-43 — Mirror Match

The healthy hand shows a pattern of squeezes and motions (tilts and rotations); the affected hand copies it as closely as possible (two balls, or one ball in turn). Scored on how closely the copy matches the original in force, direction and timing.

**Why:** Uses the stronger side as a guide, similar to mirror therapy, and scores symmetry of both force and movement.

`Uses: pressure + rotation, left vs right` · `Effort: M` · **For: Stroke**

#### D-44 — Grasp & Release Shop

Pick items off shelves by squeezing, carry them, and release into the basket at the right moment.

**Why:** Release is often harder than grasp after stroke because of flexor tone.

`Uses: pressure (grasp/hold/release)` · `Effort: M` · **For: Stroke**

#### D-45 — Kitchen Tasks

Stir a pot (circular tilt), wring a cloth (squeeze + rotate), pour a drink (slow tilt).

**Why:** Practises everyday tasks, which transfer best to real life.

`Uses: rotation + pressure` · `Effort: M` · **For: Stroke**

### Neuropathy

#### D-46 — Feel the Force

Reach a target grip with the gauge hidden, then reveal how close you were.

**Why:** Reduced sensation leads to poor force control; this trains it without relying on touch.

`Uses: pressure (blind matching)` · `Effort: S` · **For: Neuropathy**

#### D-47 — Feather Touch

Very light pressure zones must be held without overshooting, like holding an egg.

**Why:** People with numb hands tend to over-grip and drop things; this trains a light touch.

`Uses: pressure (low precision)` · `Effort: S` · **For: Neuropathy**

#### D-48 — Foot Roll

Ball under the foot, roll it in steady patterns to keep a garden watered.

**Why:** Stimulates the soles and encourages foot movement and circulation.

`Uses: rotation + acceleration (foot)` · `Effort: S` · **For: Neuropathy**

#### D-49 — Balance Beacon

Stand holding the ball to the chest; staying steady keeps a lighthouse lit as tasks get harder.

**Why:** Neuropathy raises fall risk; balance training is the key prevention.

`Uses: acceleration (sway)` · `Effort: M` · **For: Neuropathy**

#### D-50 — Fingertip Dial

Rotate the ball in tiny, precise steps to tune a radio to the right station.

**Why:** Fine dexterity drops with neuropathy; small controlled rotations train it.

`Uses: rotation (small steps)` · `Effort: S` · **For: Neuropathy**

### Tendinopathy

#### D-51 — Lighthouse Holds

Five 45-second holds at about 70% of max effort keep a lighthouse lit; a pain rating is asked between sets.

**Why:** Isometric holds give short-term pain relief and are a common first-line treatment.

`Uses: pressure (long isometric)` · `Effort: S` · **For: Tendinopathy**

#### D-52 — Tempo Lift

Follow a slow 3-second rise and 3-second lowering curve, repeated in sets.

**Why:** Heavy slow resistance is one of the best-supported tendon loading methods.

`Uses: pressure (tempo curve)` · `Effort: S` · **For: Tendinopathy**

#### D-53 — Eccentric Descent

Reach full effort, then lower slowly along a guide line to land a glider.

**Why:** Eccentric loading is a long-standing tendinopathy treatment.

`Uses: pressure (eccentric)` · `Effort: S` · **For: Tendinopathy**

#### D-54 — Load Ladder

Levels unlock week by week, but only if the patient's pain rating stays at or below 3/10.

**Why:** Builds in the pain-monitoring model clinicians use to progress tendon load safely.

`Uses: pressure + pain log` · `Effort: M` · **For: Tendinopathy**

#### D-55 — Grip Climb

Sustained medium grips, with the wrist held slightly extended, climb a rock wall.

**Why:** Targets lateral elbow tendinopathy (tennis elbow), which grip loading directly affects.

`Uses: pressure + rotation (wrist position)` · `Effort: S` · **For: Tendinopathy**

## Tier six · Multiplayer — Five games for two or more players

Games played with someone else in the room. The first two work with a single ball by taking turns, so they can be built today. The last three need two balls connected at once, which depends on X-02's two-connection work (stub S-254).

### G-11 — Pass the Bomb

A fuse burns on screen. Whoever holds the ball squeezes to the target force shown, then passes the ball before the fuse runs out. The target changes every round, so players practise controlled force, not just maximum force.

**Why:** A group game with one ball. Works for children and group sessions, and rewards precision over raw strength.

`Uses: pressure, one ball, turn-based` · `Effort: S` · `Needs: nothing new` · **Lift: engagement, group sessions**

### G-12 — Beat My Score

A hot-seat mode for any existing game: players take turns on the same game and settings, and the app keeps a scoreboard for the session.

**Why:** Patient against therapist with almost no new code — the games already exist; this adds a player switch and a results screen.

`Uses: any existing game, one ball, turn-based` · `Effort: S` · `Needs: nothing new` · **Lift: engagement, adherence**

### G-13 — Tug of War

A rope in the middle of the screen; whoever squeezes harder pulls it their way. Each player's force is measured against their own strength test, so a weak patient can beat a strong therapist.

**Why:** The simplest possible head-to-head game — short, intense rounds that anyone understands instantly.

`Uses: pressure, two balls at once` · `Effort: M` · `Needs: X-02 (S-254)` · **Lift: engagement, unit sales**

### G-14 — Pong

Each player tilts their ball to move their paddle; a squeeze gives a speed boost or a power shot.

**Why:** Uses the tilt controls the games already have, and targets wrist and forearm range of motion in a format everyone knows.

`Uses: rotation + pressure, two balls at once` · `Effort: M` · `Needs: X-02 (S-254)` · **Lift: engagement, range of motion**

### G-15 — Team Rocket

Co-operative, not competitive: both players squeeze to keep one shared rocket flying through Asteroid-style gaps. It only stays level when both hold steady force together.

**Why:** For family sessions, or a therapist guiding a patient without competing against them.

`Uses: pressure, two balls at once, co-operative` · `Effort: M` · `Needs: X-02 (S-254)` · **Lift: engagement, family involvement**

## Tier seven · Two-ball games — More ideas for a pair of balls

More games that use two balls at once, on top of X-02 (head-to-head), X-03 (bilateral training) and G-13–G-15. The first five are for one patient with a ball in each hand; the last two are for two players. All of them depend on the two-connection work in stub S-254.

### One player, a ball in each hand

#### G-16 — Rowing Boat

A ball in each hand works the oars. Squeezing both together rows straight; an uneven squeeze turns the boat off course, so the patient has to balance the force of both hands to reach the finish.

**Why:** Makes left/right imbalance instantly visible and trains symmetry without a number on screen — the boat drifting is the feedback.

`Uses: pressure, left + right, symmetry` · `Effort: M` · `Needs: X-02 (S-254)`

#### G-17 — Two-Hand Rhythm

A rhythm game with two lanes, one per hand. Notes fall in the left or right lane, or both at once, and the matching hand squeezes in time.

**Why:** Trains timing and independent control of each hand; chords (both lanes) train doing two things at once.

`Uses: pressure, left + right, timing` · `Effort: M` · `Needs: X-02 (S-254)`

#### G-18 — Balance Scale

A scale with a bowl on each side. The patient holds both hands at equal force so the scale stays level while weights are added to one side, forcing that hand to work harder.

**Why:** Sustained, controlled force with both hands at once, with the trainer choosing which side gets the extra load.

`Uses: pressure, left + right, isometric` · `Effort: S` · `Needs: X-02 (S-254)`

#### G-19 — Steering Wheel

The two balls are held like a steering wheel. Tilting them in opposite directions turns the car; squeezing both accelerates.

**Why:** Coordinated two-hand movement in a familiar motion, using the tilt controls the games already have.

`Uses: rotation + pressure, left + right` · `Effort: M` · `Needs: X-02 (S-254)`

#### G-20 — Archery

One hand holds the bow steady by keeping its ball still and aimed with tilt; the other hand squeezes to draw the string and releases to shoot.

**Why:** Each hand has a different job at the same time — stability on one side, force on the other — which is how many daily tasks work.

`Uses: rotation + steadiness + pressure, left + right` · `Effort: M` · `Needs: X-02 (S-254)`

### Two players, one ball each

#### G-21 — Sprint Relay

Each player has a lane. Quick squeezes make their runner sprint; teams can pass the baton between rounds.

**Why:** Fast, simple competition for groups, with each player measured against their own strength test.

`Uses: pressure bursts, two players` · `Effort: S` · `Needs: X-02 (S-254)`

#### G-22 — Throw & Catch

One player throws by squeezing — harder throws go further. The other tilts their ball to move a basket and catch. Then they swap roles.

**Why:** Co-operative with different jobs for each player: force for one, aiming for the other.

`Uses: pressure + rotation, two players, co-operative` · `Effort: M` · `Needs: X-02 (S-254)`

## Tier eight · Press + move — Five games where both are needed at once

In every game here, progress needs a squeeze and a movement at the same time: stopping either one stops the game. They use the tilt and squeeze controls the app already has.

### G-24 — Crane Claw

Tilt moves the claw over a prize and a squeeze closes it. The prize only stays in the claw while the squeeze holds, so the player has to keep squeezing while tilting to carry it to the chute. Release or stop moving and the prize drops or never arrives.

**Why:** Both inputs are needed at the same moment: the grip protects the prize while the movement delivers it. Close to what Roll the Ball already does, so it is cheap to build.

`Uses: pressure + rotation, held together` · `Effort: S` · `Needs: nothing new`

### G-25 — Spray Painter

Tilt moves a spray can across a wall and squeeze controls the paint flow. No squeeze paints nothing, and a heavy squeeze while standing still makes drips. The goal is an even coat over a shape.

**Why:** Movement without pressure does nothing and pressure without movement spoils the result, so the player has to do both together.

`Uses: pressure + rotation, continuous` · `Effort: S` · `Needs: nothing new`

### G-26 — Balloon Maze

Squeeze keeps a balloon at the right size and tilt steers it through a maze. Squeeze too little and it sinks onto the floor; too hard and it pops on the ceiling spikes. Steering only works while the balloon stays in its safe size band.

**Why:** Trains steady force and controlled movement at once, with a clear fail state for each.

`Uses: pressure + rotation, held together` · `Effort: M` · `Needs: nothing new`

### G-27 — Calligraphy

Tilt moves a brush along a curved path and squeeze sets the stroke thickness. The path is thicker and thinner along its length, so the player has to follow the line and match its width together. Scored on how closely they stay on the line and in the width.

**Why:** Precise two-channel control: position and force have to be right at the same moment, which is how many fine hand tasks work.

`Uses: pressure + rotation, precision` · `Effort: M` · `Needs: nothing new`

### G-28 — Fishing Reel

Tilt keeps the rod pointing at a fish that darts around, and squeeze reels it in. The reel only works while the rod stays on the fish, and the line snaps if the squeeze goes above a tension band. Progress is the fish getting closer.

**Why:** Both inputs are needed every second to make progress, and the tension band rewards controlled rather than maximal force.

`Uses: pressure + rotation, tracking` · `Effort: M` · `Needs: nothing new`

## If only three things happen next

The tiers are not a queue, and shipping all thirty is not the point. If the next quarter can hold three items, the argument for these three is that each unlocks the next:

- **R-05, limb symmetry.** Days of work, and it immediately makes the app speak the language clinicians already make decisions in.
- **R-03, a shareable report.** The only artefact that leaves the clinic and reaches a referrer, a family, or a payer. Every sales conversation gets easier.
- **M-01, the registry.** Not built next quarter — but the consent language, the schema and the opt-in have to be designed before the next hundred devices ship, or you will spend years collecting data you are not permitted to use.

Everything in Tier three is downstream of that last decision. The registry is the only item on this page whose cost rises the longer it waits.

*Playwork · Forward Register · 112 proposals · 31 August 2026 (Game Concepts added 30 September 2026, Conditions added 7 October 2026, Multiplayer and two-ball games and press + move games added 12 October 2026)*
