import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The queue files are chosen from env at import time, so point them at a scratch folder first.
const dir = mkdtempSync(join(tmpdir(), 'genq-'))
process.env.SPEC_WEB_DATA_DIR = dir
const job = (id, extra) => ({ id, status: 'queued', count: 1, createdAt: new Date(Date.parse('2026-01-01') + extra).toISOString(), ...extra && {} })
writeFileSync(join(dir, 'images-gen-queue.json'), JSON.stringify({ jobs: [{ ...job('i1', 1000), asset: 'a/one' }, { ...job('i2', 3000), asset: 'a/two' }] }))
writeFileSync(join(dir, 'audio-gen-queue.json'), JSON.stringify({ jobs: [{ ...job('s1', 2000), name: 'pickup' }, { ...job('s2', 4000), name: 'x', status: 'running' }] }))

describe('shared generation queue', () => {
  it('lists running first, then queued oldest first across art and audio', async () => {
    const { listGenQueue } = await import('./gen-queue.mjs')
    const q = await listGenQueue()
    expect(q.running.map((r) => r.id)).toEqual(['s2'])
    expect(q.queued.map((r) => r.id)).toEqual(['i1', 's1', 'i2'])
  })
  it('moves a job up one place or to the front, across both files', async () => {
    const { moveGenJob } = await import('./gen-queue.mjs')
    expect((await moveGenJob('image', 'i2', 'up')).queued.map((r) => r.id)).toEqual(['i1', 'i2', 's1'])
    expect((await moveGenJob('audio', 's1', 'top')).queued.map((r) => r.id)).toEqual(['s1', 'i1', 'i2'])
    expect(await moveGenJob('audio', 'gone', 'up')).toBeNull()
  })
})
