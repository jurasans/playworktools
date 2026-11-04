# Local image generation (ComfyUI + SDXL, Docker, RTX GPU)

Batch-generates illustrations locally using a Dockerized ComfyUI + SDXL, driven
by a single CLI. Built for the Memory Cards Match card-art set (CLAUDE.md's
S-38 stub — 50 flat-vector-icon illustrations), but `generate.mjs` works for
any prompt-template + replacement-variable batch.

Tested on: Windows 11, Docker Desktop (WSL2 backend), RTX 3070 8GB.

## One-time setup

1. **Docker Desktop GPU support** — Settings → Resources → confirm GPU is available. Verify:
   ```
   docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
   ```
   This must print your GPU. If it doesn't, fix that before anything here will work.

2. **First boot** (one-time, ~10-20 min): the container clones ComfyUI, builds
   a Python venv, and installs torch+CUDA from scratch. Every boot after this
   is fast (seconds) because that all persists in `basedir/` on disk.
   ```
   node start.mjs
   ```
   Watch progress with `docker compose logs -f` in another terminal if you want to see it working.

3. **Get the checkpoint** — too large to auto-download blind:
   - **SDXL base checkpoint** (~6.9GB, public, no login needed):
     https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors
     → save as `basedir/models/checkpoints/sd_xl_base_1.0.safetensors`
   - **No LoRA needed** — see "Why there's no LoRA" below. `--lora`/`--lora-weight`
     flags still exist on `generate.mjs` if you want to experiment with a
     different style LoRA later, but the default (`--lora-weight 0`) skips it.

4. Stop the container when you're done for now: `node stop.mjs`

## Everyday usage

**Generate a batch** (starts the container, generates every image one at a time, stops the container when done):
```
node generate.mjs --prompt-file vars/style-prompt.txt --vars-file vars/memorycards-50.txt
```
This is the exact command for the Memory Cards Match set — `vars/style-prompt.txt`
and `vars/memorycards-50.txt` are already filled in with the real style block
and the 50 subjects (car, apple, dog, key, ... — matches `src/games/memorycards/vocab.ts`).
Output lands in `data/output/<slug>.png`, one file per variable (e.g. `car.png`, `bell_pepper.png`).

**Quick test before committing to all 50** — generate just the first 3:
```
node generate.mjs --prompt-file vars/style-prompt.txt --vars-file vars/memorycards-50.txt --count 3
```

**One-off custom batch:**
```
node generate.mjs --prompt "a {{VAR}}, flat vector icon, centered" --vars "car,apple,dog" --seed 7
```

**Manual/adhoc use via the web UI** (leaves the container running so you can
iterate in ComfyUI's own browser UI at http://127.0.0.1:8188):
```
node start.mjs
# ... use the web UI, or point generate.mjs at it with --keep-running ...
node stop.mjs
```

Full flag reference: `node generate.mjs --help`

**Generation speed**: the very first image after a fresh container boot pays a
one-time cost (~5 min on an RTX 3070) for CUDA kernel JIT-compilation and
moving the checkpoint into VRAM, on top of the actual sampling. Every
generation after that in the same session is much faster (~15-30s for 25
steps at 1024x1024) since the model stays resident.

## Post-processing (two modes)

`postprocess.mjs` bulk-processes a folder of generated images into
app-ready assets — no Docker/GPU needed for this step, runs entirely on CPU.
Two modes, chosen with `--remove-bg` (default) / `--no-remove-bg`:

**`--remove-bg` (default)** — for isolated-icon art (flashcard-style, subject on its own background):
```
node postprocess.mjs --in data/output --out data/processed
```
1. **Removes the background** for real (`@imgly/background-removal-node`, ONNX-based, local/offline) — SDXL can't emit true alpha transparency, "white background" in a prompt is just white pixels, not a transparent PNG.
2. **Trims** the transparent margin the cutout leaves (`--no-trim` to skip).
3. **Resizes + pads to a square** (default 512×512).
4. **Re-encodes to WebP** (lossless by default).

**`--no-remove-bg`** — for full-scene art where the generated background is meant to stay (this is what Memory Cards Match's card illustrations actually use):
```
node postprocess.mjs --in data/output --out data/processed --no-remove-bg --size 320
```
Just resizes (aspect ratio preserved, no forced square canvas, no trim, background kept intact) and re-encodes. Verified on the full 50-image Memory Cards set: 1024px → 320px is still 3x oversampled for retina at the game's 96px max on-screen card size (`MAX_CARD_PX` in `src/games/memorycards/constants.ts`) — zero visible quality loss, 35.0MB → 2.8MB (**-92%**).

Shared flags: `--size`, `--fit` (`inside`/`cover`/`contain`/`fill`/`outside`), `--quality` (omit for lossless WebP), `--format` (`webp`/`png`). `--pad-pct` only applies in `--remove-bg` mode. Full reference: `node postprocess.mjs --help`.

This has its own `package.json`/`node_modules` (`@imgly/background-removal-node`, `sharp`) scoped to `tools/generate/` — run `npm install` in this folder once before using it. Kept separate from the main app's dependencies since this is a dev-only asset tool, never shipped.

## Wiring results straight into the app (`--wire-to`)

Every generator (`generate.mjs`, `generate-flux.mjs`, `generate-flux-img2img.mjs`, `generate-sound.mjs`) and `postprocess.mjs` accept a `--wire-to <dir>` flag pointing at the app's real live asset folder for that batch (e.g. `../../public/audio/sfx`, `../../public/images/othertests`). The policy:

- **First result for a given key** (no file with that name at `--wire-to` yet) — written straight there immediately. This is the "no need to wait" case: the very first version of an asset goes live the moment it's generated, no manual copy/review step required.
- **Any later regeneration of the same key** (the live file already exists at `--wire-to`) — the live file is left completely untouched, and the new result is saved instead under `data/versions/<key>/v2.<ext>`, `v3.<ext>`, etc. (auto-incrementing, persists across separate runs). Review those and manually copy one over the live file when you actually want to promote it.

```
node generate-sound.mjs --prompt-file vars/sfx-style-prompt.txt --vars-file vars/sfx-9-effects.txt --wire-to ../../public/audio/sfx
node postprocess.mjs --in data/output --out data/processed --no-remove-bg --size 320 --wire-to ../../public/images/memorycards
```

Omit `--wire-to` entirely to keep the old behavior (everything just goes to `--out`, nothing touches the app). The shared logic lives in `lib/wireOutput.mjs`.

## Why there's no LoRA

The original plan used a "Flat Illustration" LoRA (Civitai, trigger word
`chatu`) to push SDXL toward a flat-icon style. **Tested and rejected**: at
both weight 0.8 and 0.3, with two different prompt phrasings, it reliably
produced a busy tiled grid of dozens of tiny subjects instead of one clean
isolated icon (its own Civitai sample images are character illustrations —
"standing, no humans, full body" — so it's plausibly trained for that, not
isolated object icons, and doesn't generalize well to "a car"/"an apple"/etc).
Disabling it entirely (`--lora-weight 0`) with an explicit anti-grid negative
prompt produces a clean single-subject icon on the first try. Base SDXL 1.0
alone already has a nice flat, bold-outline look for this kind of prompt —
no style LoRA turned out to be necessary.

## Tuning the look

- `--lora` / `--lora-weight <0-1>` — kept for experimenting with a *different* style LoRA later (default weight is `0`, i.e. off). If you try another LoRA, check its Civitai page for the composition it was actually trained on (character vs. object vs. scene) before assuming it'll generalize to "a single X icon."
- `--seed` / `--vary-seed` — by default every image uses the *same* seed (only the subject text changes), which keeps compositions/lighting more consistent across the set. Pass `--vary-seed` to increment the seed per image instead, for more variety.
- `--negative "<text>"` — override the built-in negative prompt (`workflow.api.json`'s node "7", which already includes anti-grid/anti-multiple terms — see above) if a particular subject keeps producing unwanted artifacts.
- `--steps` / `--cfg` / `--sampler` — standard SDXL knobs if you want to trade speed for quality or vice versa.
- **Prompt structure matters more than any single knob**: put the subject *first*, keep it short/tag-style (comma-separated, not flowing prose) — CLIP's text encoder truncates long prompts, so burying the subject at the end of a long paragraph risks it never being read at all.

## How it works

- `docker-compose.yml` — defines the `playwork-comfyui` service (`mmartial/comfyui-nvidia-docker`, GPU passthrough via the `deploy.resources.reservations.devices` block).
- `workflow.api.json` — a ComfyUI **API-format** prompt graph (checkpoint → LoRA → CLIP text encode ×2 → KSampler → VAE decode → SaveImage). `generate.mjs` deep-clones this per image and overwrites the positive prompt text, seed, and filename before queuing it.
- `lib/docker.mjs` — start/stop/wait-until-ready helpers. `startContainer()` also fixes bind-mount ownership automatically (see the "Known quirks" note below) before every `docker compose up -d`.
- `lib/comfyClient.mjs` — thin wrapper over ComfyUI's HTTP API: queue a prompt, poll `/history/<id>` until it's done, fetch the finished PNG's bytes.
- `generate.mjs` — the CLI: starts the container, loops the variable list **sequentially** (one image at a time — deliberate, since an 8GB card can't usefully run multiple SDXL generations in parallel anyway), writes each result as `<slug>.png`, then tears the container down (`docker compose down`) in a `finally` block so it always happens even if a generation fails partway through — unless `--keep-running` is passed.
- `start.mjs` / `stop.mjs` — standalone wrappers around the same start/stop lifecycle, for manual/adhoc use outside the batch flow.
- `postprocess.mjs` — CPU-only bulk post-processing (background removal, trim, resize/pad, WebP re-encode); see the section above. Independent of the Docker/GPU pipeline — can run anytime after `generate.mjs` finishes.

## Known quirks (found while building/testing this)

- **Git Bash + Docker Desktop path mangling**: running from Git Bash on Windows, `docker run -v $(pwd)/x:/y` gets its path silently rewritten and creates garbage directories (e.g. a stray `run;C` folder) instead of mounting correctly. Fixed by setting `MSYS_NO_PATHCONV=1` for every docker invocation in `lib/docker.mjs` — already handled, nothing to do.
- **Bind-mount ownership**: the image expects `run/` and `basedir/` to be owned by uid:gid `1000:1000` inside the container; fresh directories created via a Windows/WSL2 bind mount default to root. `startContainer()` runs a one-off `alpine chown` fix automatically before every start — already handled.
- **First boot is slow, subsequent boots are fast**: see step 2 above. `waitForReady()`'s default timeout is 20 minutes to accommodate a cold first boot; don't lower it unless you know your venv/ComfyUI checkout already exists in `basedir/`.
- This was built and tested end-to-end on this machine (RTX 3070, Windows 11, Docker Desktop/WSL2) up through container boot and the ComfyUI API responding. If you hit an error not covered here, `docker compose logs -f` (run from this folder) is the first thing to check.
