import { describe, expect, it } from 'vitest'
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { batchEvents, createPush, diffSnapshots, encryptPayload } from './push-lib.mjs'

// What a browser does with the message: RFC 8291 decryption with the subscription's own keys.
function decrypt(body, ua, authSecret) {
  const salt = body.subarray(0, 16), idLen = body[20], asPublic = body.subarray(21, 21 + idLen), cipherText = body.subarray(21 + idLen)
  const uaPublic = ua.getPublicKey(), secret = ua.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipherText.subarray(-16))
  const plain = Buffer.concat([d.update(cipherText.subarray(0, -16)), d.final()])
  return plain.subarray(0, plain.lastIndexOf(2)).toString()
}

function subscription() {
  const ua = createECDH('prime256v1'); ua.generateKeys()
  const auth = randomBytes(16)
  return { ua, auth, sub: { endpoint: 'https://push.example/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } }
}

describe('push-lib', () => {
  it('encrypts a payload the subscription can decrypt', () => {
    const { ua, auth, sub } = subscription()
    const body = encryptPayload('{"title":"héllo ✓"}', sub.keys.p256dh, sub.keys.auth)
    expect(decrypt(body, ua, auth)).toBe('{"title":"héllo ✓"}')
  })

  it('broadcasts with a VAPID header, and drops subscriptions the service reports gone', async () => {
    const calls = []
    const push = createPush({ file: join(mkdtempSync(join(tmpdir(), 'push-')), 'push.json'), fetchImpl: async (url, init) => { calls.push({ url, init }); return { status: url.endsWith('gone') ? 410 : 201 } } })
    const live = subscription().sub, dead = { ...subscription().sub, endpoint: 'https://push.example/gone' }
    push.subscribe(live); push.subscribe(dead)
    await push.broadcast({ title: 'x' })
    expect(calls).toHaveLength(2)
    expect(calls[0].init.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/)
    expect(calls[0].init.headers['content-encoding']).toBe('aes128gcm')
    expect(push.count()).toBe(1)
  })

  it('keeps its VAPID key across restarts and refuses a non-https endpoint', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'push-')), 'push.json')
    expect(createPush({ file }).publicKey()).toBe(createPush({ file }).publicKey())
    expect(() => createPush({ file }).subscribe({ endpoint: 'http://x', keys: { p256dh: 'a', auth: 'b' } })).toThrow()
  })

  const snap = (o = {}) => ({ work: [], stubs: [], nightly: { running: false, finishedAt: null, summary: '' }, lastRun: null, ...o })

  it('turns snapshot changes into events; only things that need a person stay on screen', () => {
    const prev = snap({ work: [{ id: 'WI-1', title: 'T', status: 'analyzing', waiting: false }], stubs: [{ id: 'S-1', title: 'S', status: 'deferred', ready: false }] })
    const cur = snap({
      work: [{ id: 'WI-1', title: 'T', status: 'questions', waiting: false }, { id: 'WI-2', title: 'N', status: 'collected', waiting: false }],
      stubs: [{ id: 'S-1', title: 'S', status: 'deferred', ready: true }], nightly: { running: false, finishedAt: 5, summary: 'Everything passed' },
    })
    expect(diffSnapshots(prev, cur).map((e) => [e.title, !!e.sticky])).toEqual([
      ['Nightly run succeeded', true], ['WI-1 is needs answers', true], ['WI-2 was created', false], ['S-1 is ready to enable', true]])
    expect(diffSnapshots(cur, cur)).toEqual([])
  })

  it('phase updates do not stay, failures and QA do', () => {
    const at = (status) => snap({ work: [{ id: 'WI-1', title: 'T', status, waiting: false }], stubs: [{ id: 'S-1', title: 'S', status: 'enabled', ready: false }] })
    const sticky = (status) => diffSnapshots(at('analyzing'), at(status))[0].sticky
    for (const phase of ['rewriting', 'working', 'approved']) expect(sticky(phase)).toBe(false)
    for (const attention of ['questions', 'spec-review', 'in-qa', 'failed']) expect(sticky(attention)).toBe(true)
    const stub = (status) => snap({ stubs: [{ id: 'S-1', title: 'S', status, ready: false }] })
    expect(diffSnapshots(stub('enabled'), stub('in-progress'))[0].sticky).toBe(false)
    expect(diffSnapshots(stub('in-progress'), stub('in-qa'))[0].sticky).toBe(true)
  })

  it('reports a failed nightly and a finished START WORKING run, once, and never on the first snapshot', () => {
    const night = (finishedAt, summary) => snap({ nightly: { running: false, finishedAt, summary } })
    expect(diffSnapshots(night(1, 'Everything passed'), night(2, 'Failed: unit'))).toMatchObject([{ title: 'Nightly run failed', sticky: true, global: true }])
    const run = (id, status) => snap({ lastRun: { id, status, summary: 'done' } })
    expect(diffSnapshots(run('r1', 'running'), run('r1', 'done'))).toMatchObject([{ title: 'START WORKING run succeeded', sticky: true, global: true }])
    expect(diffSnapshots(run('r1', 'running'), run('r1', 'failed'))[0].title).toBe('START WORKING run failed')
    expect(diffSnapshots(run('r1', 'done'), run('r1', 'done'))).toEqual([])
    expect(diffSnapshots({ ...snap(), lastRun: undefined }, run('r1', 'done'))).toEqual([])
  })

  it('collapses a burst into one card that stays if anything needs attention', () => {
    const e = (title, sticky) => ({ title, body: '', tab: 'stubs', tag: title, sticky })
    expect(batchEvents([e('a'), e('b'), e('c')])).toHaveLength(3)
    const one = batchEvents([e('S-1 is in QA', true), e('S-2 enabled'), e('S-3 enabled'), e('S-4 enabled'), e('S-5 enabled')])
    expect(one).toHaveLength(1)
    expect(one[0]).toMatchObject({ title: '5 updates in spec-web (1 need you)', sticky: true, tag: 'batch' })
    expect(one[0].body.startsWith('S-1 is in QA')).toBe(true)
    expect(batchEvents([e('a'), e('b'), e('c'), e('d')])[0].sticky).toBe(false)
  })
})
