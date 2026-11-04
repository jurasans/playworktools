import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.SPEC_WEB_DATA_DIR = mkdtempSync(join(tmpdir(), 'aud-'))
const { audioMeta, audioKeptKey, setAudioComplete, enforceSingleKeep } = await import('./audio-lib.mjs')

const entry = (o = {}) => ({ decision: 'reject', feedback: '', candidates: {}, ...o })

describe('audio integration meta', () => {
  it('a kept generated clip is integrated only once its key is recorded', () => {
    const e = entry({ candidates: { 'gen/audio-output/x/pickup_v1.mp3': { decision: 'keep' } } })
    expect(audioMeta('pickup', 'sfx', e).integrated).toBe(false)
    e.integratedKey = audioKeptKey(e)
    expect(audioMeta('pickup', 'sfx', e).integrated).toBe(true)
  })
  it('keeping the live file counts as integrated; a different kept clip is not', () => {
    expect(audioMeta('pickup', 'sfx', entry({ decision: 'keep' })).integrated).toBe(true)
  })
  it('Complete needs integration', () => {
    const e = entry({ candidates: { 'gen/audio-output/x/pickup_v1.mp3': { decision: 'keep' } } })
    expect(() => setAudioComplete(e, 'pickup', 'sfx', true)).toThrow()
    e.integratedKey = audioKeptKey(e)
    setAudioComplete(e, 'pickup', 'sfx', true)
    expect(audioMeta('pickup', 'sfx', e).completed).toBe(true)
  })
  it('multi allows several kept clips', () => {
    const e = entry({ multi: true, candidates: { a: { decision: 'keep' }, b: { decision: 'keep' } } })
    enforceSingleKeep(e, 'b')
    expect(e.candidates.a.decision).toBe('keep')
    const f = entry({ candidates: { a: { decision: 'keep' }, b: { decision: 'keep' } } })
    enforceSingleKeep(f, 'b')
    expect(f.candidates.a.decision).toBe('reject')
  })
  it('previews the prompt with a rewrite folded in', () => {
    const m = audioMeta('pickup', 'sfx', entry({ feedback: 'too shrill', rewrite: { notes: 'too shrill', positive: 'soft', negative: 'shrill', source: 'claude' } }))
    expect(m.prompt.rewrittenBy).toBe('claude')
    expect(m.prompt.negative).toContain('shrill')
  })
})
