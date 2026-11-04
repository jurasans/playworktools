import { describe, it, expect } from 'vitest'
import { resolveImageId } from './images-lib.mjs'

describe('resolveImageId', () => {
  it('accepts candidates and previews of a known group', () => {
    expect(resolveImageId('player/ship_v1.png')).toBeTruthy()
    expect(resolveImageId('background/preview/bg_v2.webp')).toBeTruthy()
  })
  it('rejects unknown groups, traversal, odd depth and non-image files', () => {
    for (const id of ['x/a.png', '../a.png', 'player/../a.png', 'player/a/b/c.png', 'player/other/a.png', 'player/a.txt', 'player', '']) {
      expect(resolveImageId(id), id).toBeNull()
    }
  })
})

describe('setDecision', () => {
  it('keeps one candidate per asset and mirrors it into pick', async () => {
    const { setDecision } = await import('./images-lib.mjs')
    const e = { candidates: {}, pick: null }
    setDecision(e, 'a/x_v1.png', 'keep')
    setDecision(e, 'a/x_v2.png', 'keep')
    expect(e.pick).toBe('a/x_v2.png')
    expect(e.candidates['a/x_v1.png'].decision).toBe('reject')
    setDecision(e, 'a/x_v2.png', 'reject')
    expect(e.pick).toBeNull()
  })
})

describe('multiple keeps', () => {
  it('allows several keeps only when multi is on, and turning it off leaves the latest', async () => {
    const { setDecision, setMulti } = await import('./images-lib.mjs')
    const e = { candidates: {}, pick: null, multi: true }
    setDecision(e, 'a/x_v1.png', 'keep'); setDecision(e, 'a/x_v2.png', 'keep')
    expect(Object.values(e.candidates).filter((c) => c.decision === 'keep')).toHaveLength(2)
    setMulti(e, false)
    expect(e.candidates['a/x_v1.png'].decision).toBe('reject')
    expect(e.pick).toBe('a/x_v2.png')
  })
})

describe('listImages catalog', () => {
  it('lists every cataloged asset, with usage details, even before it has candidates', async () => {
    const { listImages } = await import('./images-lib.mjs')
    const { IMAGE_CATALOG } = await import('./images-catalog.mjs')
    const { assets } = await listImages()
    for (const c of IMAGE_CATALOG) expect(assets.some((a) => a.asset === c.asset && a.triggers.length > 0), c.asset).toBe(true)
  })
})

describe('notes become prompt wording', () => {
  it('moves "what to leave out" notes to the negative prompt and keeps the rest as wording', async () => {
    const { splitNotes, composePrompt } = await import('../../tools/generate/spacechase-prompts.mjs')
    expect(splitNotes("No wings. Too many flames; make the hull smoother. I don't like the red stripes")).toEqual({
      positive: 'make the hull smoother', negative: 'wings, flames, red stripes',
    })
    const p = composePrompt('player', 'player spaceship standard flight', 'no wings. rounder nose')
    expect(p.positive).toContain('player spaceship standard flight')
    expect(p.positive.endsWith(', rounder nose')).toBe(true)
    expect(p.negative.endsWith(', wings')).toBe(true)
  })
})

describe('integration and completion', () => {
  it('is integrated only for the exact kept set, and completes only once integrated', async () => {
    const { setDecision, assetMeta, setComplete, keptKey } = await import('./images-lib.mjs')
    const asset = { group: 'player', subject: 'player spaceship standard flight' }
    const e = { candidates: {}, pick: null }
    setDecision(e, 'player/x_v1.png', 'keep')
    expect(assetMeta(asset, e).integrated).toBe(false)
    expect(() => setComplete(e, true)).toThrow()
    e.integratedKey = keptKey(e); e.integratedAt = 'now'
    expect(assetMeta(asset, e).integrated).toBe(true)
    setComplete(e, true)
    expect(assetMeta(asset, e).completed).toBe(true)
    setDecision(e, 'player/x_v2.png', 'keep') // a different pick after integration reopens the asset
    expect(assetMeta(asset, e).integrated).toBe(false)
    expect(assetMeta(asset, e).completed).toBe(false)
  })
})
