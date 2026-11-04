# Images

Generated art is reviewed here, below this text. The first set is **Space Chase** (WI-1): the player ship, the enemy ship, five asteroid shapes and five space backgrounds, several candidate versions each, made by the local SDXL pipeline in `tools/generate/` (ComfyUI in Docker on the host GPU).

**Workflow**

1. Generate: `node tools/generate/spacechase-art.mjs --variants 4` (add `--only player,enemy,asteroid,background` or `--seed N` for another round; `--seed-shift`). Output lands in `tools/generate/data/spacechase/<group>/<asset>_v<N>.png`; `node tools/generate/spacechase-previews.mjs` makes the thumbnails shown here.
2. Review: click the version you want for each asset (click again to clear it). Write feedback in the box to steer the next round.
3. Promote: `node tools/generate/spacechase-promote.mjs` cuts the background out of picked sprites, resizes, and writes `public/images/spacechase/*.webp`, which the game picks up with no code change (`src/games/spacechase/draw.ts`).
