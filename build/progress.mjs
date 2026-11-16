// Shared progress reporting for the build scripts: one plain line "[progress] 42% label" that rebuild-builds.mjs and a
// person watching a terminal can both read. A parent script gives a child its slice of the bar via PROGRESS_LO/HI, so
// every script reports 0-100 for itself and nested builds still add up to one monotonic bar.
export const rangeEnv = () => ({ lo: Number(process.env.PROGRESS_LO ?? 0), hi: Number(process.env.PROGRESS_HI ?? 100) })

export function mapPct(p) {
  const { lo, hi } = rangeEnv()
  return Math.round(lo + (Math.max(0, Math.min(100, p)) / 100) * (hi - lo))
}

export function progress(p, label) { console.log(`[progress] ${mapPct(p)}% ${label}`) }

/** Env for a child script that should fill this script's own from..to percent. */
export const childRange = (from, to) => ({ PROGRESS_LO: String(mapPct(from)), PROGRESS_HI: String(mapPct(to)) })
