# spec-web

A browser front-end for `tools/spec/spec.mjs` — read the spec, track stubs, answer
open questions from a phone or another machine.

**It is a wrapper, not a second implementation.** Every write shells out to the
CLI, so the atomic index+block write, the status-token preservation and the
line-ending detection in `spec.mjs` remain the *only* code path that touches
`SPEC_STUBS.md` — the repo-root file that holds the whole stub registry,
split out of `CLAUDE.md` (Key Rule 15). If this server ever grows its own
writer, that guarantee is gone.

## Run it

```bash
node tools/spec-web/server.mjs            # local only
node tools/spec-web/tunnel.mjs            # local + public Cloudflare quick tunnel
```

Both print a URL with the access token already in it. `--port N` to change port.

### Or as a container, turned on/off from Docker

```bash
docker compose -f tools/spec-web/docker-compose.yml up -d      # on
docker compose -f tools/spec-web/docker-compose.yml logs -f    # see the printed token
docker compose -f tools/spec-web/docker-compose.yml down       # off
# or, once it exists: docker start/stop playwork-spec-web
```

The image ships no app code — the whole repo is bind-mounted into the
container at `/repo`, so it always runs whatever is actually on disk (see
`Dockerfile`'s comment) and every write still lands on the real `SPEC_STUBS.md`.
Publishes on `8888` by default (`SPEC_WEB_PORT` env var to change). To point
`tunnel.mjs` at the containerized server instead of spawning its own copy,
run it with `--port 8888` and it will tunnel to whichever process already
owns that port on `127.0.0.1` — Docker's published port and a bare `node
server.mjs` are indistinguishable from the tunnel's point of view.

## Tabs

| Tab | What it does |
|---|---|
| **Spec** | The official spec: a side menu with one entry per `docs/spec/*.md` and a filterable heading list for the selected file. Never shows stubs. |
| **Stubs** | Defaults to the actionable set — deferred stubs with an unanswered blocking question — with checkboxes to widen that to ready-to-enable and `delay`-parked stubs, or pick an exact status from the dropdown. Every question renders inline on its card (answer it, edit an existing answer, or Waive) without leaving the tab. One big **SET READY** button per card moves a fully-answered stub to `enabled` — disabled while a blocking question remains, same refusal the CLI's own `enable` makes. |
| **Tests** | Unit / e2e / device-matrix results and the `▶ Run Full Suite` button (see *Test running* below). |
| **Assets** | Sub-tabs **Audio** (review every bundled sound, queue generation jobs — see *Audio tab (S-235)* below), **Images** (pick one generated candidate per Space Chase asset; `images-lib.mjs`, `/api/images*`), **Localization** (`strings.csv` as an editable grid, diffed against git; needs `git` in the container) and **Manual translation** (in-app manual, one section at a time, optional Ollama draft). |
| **Product** | Suggestions (voting by name, TAKEN stamp), Feedback (public survey editor), GDPR, Regulations, App Review. |
| **Downloads** | **Spec** (downloads the stub registry file), **Build** (nightly debug APK) and **Web build** (the dev build running in Chrome, same origin at `/web-build/`). |

The **App / Backend** switch at the top selects which stub registry (`SPEC_STUBS.md` / `SPEC_STUBS_BACKEND.md`) the Stubs tab and Download use; app-only tabs are hidden under Backend. Full detail: `docs/spec/backend-and-feedback.md`.

## Security

The spec is the product's full private design doc **and this tool can write to
it**, so an open port is both a disclosure and an integrity risk.

- Every request needs a signed-in session: username/password at `/login` (accounts and roles are the `USERS` list in `server.mjs`: `admin`, `translator`, `tester`), then a random 24 h token in an httpOnly cookie. Sessions are in memory, so a restart signs everyone out. `--no-auth` (alias `--no-token`) disables the gate — local use only. **The tunnel URL plus a login together are effectively the password: anyone with both can read the whole spec and, as admin, write answers into it.** Role limits are enforced server-side; see `docs/spec/backend-and-feedback.md` → *Sign-in and sessions*.
- Child processes use `execFile` with an argv **array**, never a shell string,
  so answer text containing `` ` ``, `;`, `$()` etc. is inert (verified).
- Stub ids are format-validated (`^S-\d+$`) before reaching the CLI.
- Static serving is a fixed allow-list — no path-traversal surface.
- A bare `node server.mjs` binds `127.0.0.1` (nothing exposed until you tunnel it). **The Docker setup does not:** the container binds `0.0.0.0` and `docker-compose.yml` publishes `8888:8888` with no host-IP prefix, so the port is reachable from the LAN and the login is the only protection. To keep it local, publish `127.0.0.1:8888:8888` instead (the tunnel still works, it connects from the host).

Kill the tunnel process to revoke access; the hostname dies with it.

## Cloudflare quick tunnel

`cloudflared tunnel --url` needs no Cloudflare account — it mints a random
`*.trycloudflare.com` hostname that lives as long as the process.

Install (Windows): `winget install --id Cloudflare.cloudflared`
Note it is **not on PATH** until the shell restarts; `tunnel.mjs` probes the
known install paths, and the default Windows location is
`C:\Program Files (x86)\cloudflared\cloudflared.exe`.

### Known issue on this machine (unresolved)

Quick tunnels currently **do not route** from here. Observed across 5+ generated
hostnames, both protocols (`quic` and `--protocol http2`), a bare `node
server.mjs`, AND the Docker container (re-confirmed after adding Docker
support, to rule out the container as the cause — it wasn't):

- all connectivity prechecks PASS, and `Registered tunnel connection
  connIndex=0` succeeds;
- but only **1 of the usual 4** connections ever registers, the log then goes
  silent, and every request to the hostname returns a bare Cloudflare **404**
  (`server: cloudflare`, no origin headers) — i.e. the edge has no route,
  the request never reaches this machine;
- the origin is healthy throughout (`curl 127.0.0.1:8888` → 200 correctly),
  whether that origin is bare-node or the container.

No error is logged, so this is not a config problem in this repo, and it isn't
Docker-related — the identical single-connection/edge-404 signature reproduces
whether the origin is `node server.mjs` directly or the containerized one on
the same port. Most likely a network path/filtering issue toward Cloudflare's
edge from this machine/network, or a transient quick-tunnel service fault.
Things worth trying: a different network (phone hotspot), `--protocol http2`
(tried, same result), or a named tunnel with a real Cloudflare account instead
of a quick tunnel (needs `cloudflared tunnel login` + a zone, more setup but a
stable hostname and no anonymous-service flakiness). The local app is
unaffected either way — `tunnel.mjs` prints the local URL right alongside the
public one.

## Test running (host-runner)

The `▶ Run Full Suite` button on the Tests tab runs unit + e2e (never the
slow device-matrix screenshot suite). `POST /api/tests/run` starts
`tools/spec/run-full-suite.mjs`, which writes live progress to
`tools/spec-web/documentation/state/test-run.json` — polled by the banner every 4s, showing
both the current run's elapsed seconds and the previous run's total for
comparison.

When spec-web itself is in Docker (`SPEC_WEB_IN_DOCKER=1`, set in
`docker-compose.yml`), the suites can't run inside the container: it bind-
mounts the repo, but `node_modules`' native addons (Vite's rollup binary)
were built for the host, not the container's Alpine/musl — `vitest`/
`playwright` fail almost instantly with `MODULE_NOT_FOUND`, which used to
look like an implausibly fast, always-broken 8-second "full run."

Fix: `tools/spec/host-runner.mjs`, a small always-on process kept running on
the actual host (`npm run spec:host-runner`). The containerized server
detects `SPEC_WEB_IN_DOCKER` and calls this process over Docker Desktop's
`host.docker.internal` instead of spawning locally; it then runs
`run-full-suite.mjs` with the host's real `node_modules`/browsers. Both
sides read/write the same `test-run.json` on the bind-mounted repo, so the
read side (`GET /api/tests/run-status`) needs no branch at all. Requests to
`host-runner.mjs` are gated by a shared token (`HOST_RUNNER_TOKEN`, same
fixed-secret convention as `AUTH_PASSWORD`/`DOWNLOAD_PASSWORD`) since it
must bind `0.0.0.0` to be reachable from the container.

## Headless Claude runs (agent bar)

The bar above every tab starts Claude Code skills unattended on this PC: **▶ START WORKING**
(`finish-ready-stubs`) and the gold **Integrate WI-n into the spec** button (`spec-work-item`, see below).
Full design: `docs/spec/spec-web-agent-runs.md`.

- `POST /api/runs/start?kind=finish-stubs` (and `/api/work/*` for work item runs) creates a run file under
  `documentation/state/runs/` and starts `tools/spec/agent-run.mjs <runId>`: directly on a bare host, or via
  `host-runner` (`/agent/start`) when spec-web runs in Docker. The worker runs
  `claude -p --output-format stream-json --dangerously-skip-permissions` with the prompt on stdin.
- One run at a time (`409` otherwise). Progress is the run's `steps` (from the stream) plus a 20 s heartbeat;
  no heartbeat for 90 s shows `stalled` with a **mark failed** link. **Stop** sets a flag the worker polls and
  kills the whole process tree. `GET /api/runs`, `/api/runs/<id>/log`.
- If a run ends without finishing, the worker clears a stuck "work in progress" banner.
- Setup: `npm install -g @anthropic-ai/claude-code`, then `claude auth login` once. A run that fails with
  "OAuth session expired" needs that login again.
- The Docker spec-web needs `host-runner`: on this PC it is the scheduled task `Playwork host-runner`
  (hidden, starts at logon), or `npm run spec:host-runner` by hand.
## Work items (Work tab)

How a hand edit of the spec becomes a rewritten spec: **Spec** edits are collected as you save; **I completed my
changes** turns them into `WI-n`; Claude analyzes it and asks questions (blocking ones must be answered); the gold
**Integrate** button rewrites the spec everywhere it applies, registers Claude-managed (read-only) stubs, builds with
sub-agents, verifies everything and leaves it in QA for **Confirm done** or **Send back**. State is
`documentation/work-items/WI-n.json` (tracked) and `documentation/state/collecting.json`. CLI: `node tools/spec/work.mjs`.
Full design: `docs/spec/spec-work-items.md`.

## Tab icon

Every page, including `/login`, carries the app logo as its tab icon (`public/favicon.png`, `public/apple-touch-icon.png`). `server.mjs` serves `/favicon.ico`, `/favicon.png` and `/apple-touch-icon.png` before the sign-in gate, from a fixed two-file allow-list (never a path taken from the request).

## Session-state banner + checklist

`node tools/spec/spec.mjs state set wip "<note>"` / `state set ready "<note>"`
drives the banner every page shows (`GET /api/session-state`, polled every
30s) — independent of the stub registry, so any long-running skill/script can
signal state without touching SPEC_STUBS.md. `wip` renders amber and pulsing
("mid-change right now"); `ready` with a note renders a static green
"Completed — <note>" line, not hidden — a finished run still wants a
one-glance summary of what to review, it just isn't a work-in-progress
warning anymore. `ready` with no note hides the banner entirely.

`state checklist-init "Step one|Step two|..."` and `state checklist-check <n>`
attach a live checklist under the banner while `wip` (persists across `state
set wip` note updates; cleared on `state set ready`, since a finished run's
green note is the summary — the step-by-step checklist isn't needed once
everything's done).

Each item is `pending` (○), `active` (a spinning circle), `done` (✓) or `failed` (✗).
`checklist-init` activates step 1, `checklist-check <n>` moves the spinner to the next
unfinished step, `checklist-start <n>` sets the running step by hand, and
`checklist-set "<label>" <status>` adds or updates a sub-step by label (placed after the last
item with the same `Prefix:`, else after the running step). `nightly-run.mjs` uses it for
`Nightly: web build / unit tests / e2e tests / screenshots tests / APK build`, only when the
banner is already `wip`. Old state files with only `done` still render. Every date the page
shows is Israel time (`fmtIL` in `index.html`, `ilTime` in `runs-lib.mjs`; IDT in summer, IST in
winter) whatever the browser's zone; stored timestamps stay UTC ISO.

**Convention:** a run that leaves anything needing the user (a stub sitting
in `in-qa`, a deferred stub now fully answered and ready to `enable`) still
sets state to **`ready`**, not `wip` — nothing is actually "in progress"
once the run itself has finished; `wip` is for the run being underway, not
for outstanding follow-ups afterward. The green note is where that
follow-up summary belongs: which stubs moved to `in-qa` and need review,
which are ready to enable, and the headline test/build result.

## Docker

See "Or as a container" above. The image is zero-dependency Node on
`node:20-alpine` with no app code baked in (the repo is bind-mounted at
runtime), so it exists purely for the "start/stop it like any other service"
convenience — it does not isolate anything the bare-node path doesn't already
isolate (no secrets, no extra deps), and it does **not** fix the tunnel issue
above, which reproduces identically through the container.

## Audio tab (S-235)

A temporary review page for every bundled sound — 16 SFX (`public/audio/sfx`)
and 7 music tracks (`public/audio/music`) — at `/audio` (App registry only;
hidden under Backend like Tests/Art). Per sound: an `<audio>` player, name,
kind, **activation details** (where in the app it fires), relevant screenshots
from `e2e-artifacts/` (click to enlarge; none shown when no captured screen is
relevant), **Keep / Reject / Undecided**, a **feedback** box ("what I don't
like / how to improve", saved on blur), a **Generate N new options** control,
and a *Candidates & versions* section with each variant's own player,
decision and notes.

Nothing here runs generation. "Queue" appends a job to a queue file; you (or a
Claude session on the host) run the host-side runner when convenient — the
server may be in Docker and can't drive the host's GPU/docker.

### Where it looks (only folders that actually contain audio are listed)

| Folder | Env override | Default |
|---|---|---|
| live app audio (`sfx/`, `music/`) | `SPEC_WEB_AUDIO_LIVE_DIR` | `<repo>/public/audio` |
| generation data (`versions/`, `audio-output/`) | `SPEC_WEB_AUDIO_GEN_DIR` | `<repo>/tools/generate/data` |
| state + queue files | `SPEC_WEB_DATA_DIR` | `<repo>/tools/spec-web/documentation/state` |
| screenshots | (fixed) | `<repo>/e2e-artifacts` |

The container already bind-mounts the whole repo at `/repo`, so all of these
resolve there with no extra volumes. Candidates are files under
`audio-output/**` named `<sound>.mp3` or `<sound>_vN.mp3`, and
`versions/<sound>/vN.mp3`; a candidate byte-identical to the live file is
tagged *identical to live*. Activation details and screenshot picks live in
`audio-catalog.mjs` (mirrors CLAUDE.md's "Sound & Music (S-29)" trigger table —
update both together). Screenshots are matched by name (`<NN>-<screen>.png`),
newest file wins, so a renumbered e2e run never breaks the link.

### File ids

State and API use ids, never raw paths: `live/<sfx|music>/<file>`,
`gen/versions/<sound>/vN.mp3`, `gen/audio-output/<...>/<file>`.

### State file — `tools/spec-web/documentation/state/audio-state.json` (gitignored)

Written atomically (tmp + rename). Read it directly from a Claude session.

```jsonc
{
  "version": 1,
  "updatedAt": "ISO",
  "files": {
    "<sound name, e.g. pickup or asteroid>": {
      "decision": "keep | reject",                // verdict on the LIVE file — defaults to
                                                    // "reject" (there is no "undecided" — a
                                                    // row with no explicit choice yet reads
                                                    // as rejected everywhere)
      "feedback": "free text: what is wrong / how to improve",
      "updatedAt": "ISO | null",
      "candidates": {                             // per candidate/version id
        "gen/audio-output/music-variants-v2/asteroid_v2.mp3": {
          "decision": "keep | reject",             // same default-reject rule
          "feedback": "optional notes on this candidate",
          "updatedAt": "ISO",
          "promotedAt": "ISO"                     // set by the runner's --promote
        }
      },
      "liveFrom": "candidate id",                 // set by --promote
      "promotedAt": "ISO"
    }
  },
  "generationRequests": [                         // append-only log (last 500)
    { "id": "job-…", "name": "pickup", "kind": "sfx", "count": 3,
      "feedbackSnapshot": "feedback text at request time",
      "candidateFeedback": [{ "id": "…", "feedback": "…" }],
      "createdAt": "ISO",
      "status": "…" }                             // mirrored back by the runner
  ]
}
```

An absent sound (or one with no explicit choice yet) = rejected. `reject` on
the live file means "replace this"; `keep` on a candidate means "promote this
one" (see below).

**Only one KEEP per sound, ever.** A sound's "kept" thing is exactly one of:
the live file, or one of its candidates — never more than one at a time. Every
`PUT .../state` that sets `decision: "keep"` (`enforceSingleKeep()` in
`audio-lib.mjs`) atomically flips whatever else was kept for that same sound
back to `reject` server-side, so the client never has to reconcile this itself
and two clients racing each other can't leave two things kept. The Audio tab's
whole card outline reflects this aggregate: green the instant anything for
that sound is kept, red only once everything (live file + every candidate) is
rejected.

**How feedback feeds generation.** When a job is queued, the sound's current
`feedback` (plus notes on non-kept candidates) is snapshotted into the job. The
runner builds the prompt as `<base description>. Refinements: <feedback>` where
the base description comes from `tools/generate/vars/*.txt` (`key|desc|seconds`,
newest file wins) or `audio-catalog.mjs`. Text-to-audio prompts work better as
positive descriptors than complaints, so a Claude session should read the
feedback and, when useful, rewrite it into descriptors by setting `promptOverride`
(a string replacing the whole description) on the queued job before running the
runner.

### Queue file — `tools/spec-web/documentation/state/audio-gen-queue.json`

```jsonc
{ "jobs": [{
  "id": "job-…", "name": "pickup", "kind": "sfx|music", "count": 3,   // count 1..10
  "feedbackSnapshot": "…", "candidateFeedback": [],
  "status": "queued | running | done | failed | cancelled",
  "createdAt": "ISO", "startedAt": "ISO", "finishedAt": "ISO",
  "outputDir": "gen/audio-output/spec-web-jobs/<id>",  // set by the runner
  "produced": ["gen/audio-output/spec-web-jobs/<id>/pickup_v1.mp3"],
  "error": "…", "warning": "…",
  "promptOverride": "optional: replaces the whole description"
}]}
```

One queued/running job per sound at a time (409 otherwise); queued jobs can be
cancelled from the UI.

### Host-side runner — `tools/generate/audio-gen-runner.mjs`

Needs Docker + GPU (see `tools/generate/README.md`); spec-web itself does not.

```bash
node tools/generate/audio-gen-runner.mjs --dry-run              # print the generate-sound command per queued job, run nothing
node tools/generate/audio-gen-runner.mjs                        # run every queued job, then exit
node tools/generate/audio-gen-runner.mjs --watch [--interval 15]
node tools/generate/audio-gen-runner.mjs --job <id>
node tools/generate/audio-gen-runner.mjs --promote [--name pickup] [--dry-run]
```

Each job runs `generate-sound.mjs --variants N` into its own folder
(`data/audio-output/spec-web-jobs/<jobId>/`, so re-runs never overwrite earlier
`_v1..` files); the new files appear as candidates on the next refresh.
`--promote` takes, per sound, the most recently updated **kept** candidate,
copies the current live file into `data/versions/<name>/vN.mp3` (next free N,
same as `--wire-to`), then copies the candidate over `public/audio/<kind>/<name>.mp3`
and stamps `promotedAt`/`liveFrom` in the state file. Rebuild the app afterwards.

### Endpoints

`GET /api/audio` (sounds, folders, jobs) · `GET|HEAD /api/audio/file?id=` (Range
supported) · `GET /api/audio/state` · `PUT /api/audio/state`
(`{name, decision?, feedback?}` or `{name, candidateId, decision?, feedback?}`) ·
`POST /api/audio/generate` (`{name, count}`) · `POST /api/audio/generate/cancel`
(`{id}`). Screenshots use the existing `GET /api/screenshot?path=`.
