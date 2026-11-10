// Web Push for spec-web with no dependencies: VAPID (RFC 8292) + aes128gcm payload encryption (RFC 8291) on node:crypto.
// Why server-side: a service worker can show a system card with the tab closed, but only a push from here can wake it.
import { createECDH, createPrivateKey, createCipheriv, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(s, 'base64url')

export const NOTIFY_LABEL = { collected: 'collected', analyzing: 'being analyzed', questions: 'needs answers', ready: 'ready to rewrite', rewriting: 'spec being rewritten',
  'spec-review': 'spec ready for review', approved: 'confirmed, ready to start', working: 'work started', 'in-qa': 'in QA, waiting for you', failed: 'stopped with a failure', done: 'done', cancelled: 'cancelled' }
export const NOTIFY_STUB = { deferred: 'back to deferred', delay: 'delayed', enabled: 'enabled, queued for work', 'in-progress': 'being worked on', 'in-qa': 'in QA, waiting for you', done: 'done' }

// Cards that stay on screen until dismissed: the ones that need a person (answer, review, QA, a failure) or report a finished run.
// Phase updates (analyzing, working, enabled...) only pop up and go.
const STICKY_WI = new Set(['questions', 'ready', 'spec-review', 'in-qa', 'failed'])
const STICKY_STUB = new Set(['in-qa'])
const BATCH_AFTER = 3

/** Turns two /api/watch snapshots into notification events. Same rules as the page's own toasts (public/index.html). */
export function diffSnapshots(prev, cur) {
  const events = []
  const index = (d) => new Map([...d.work.map((w) => [w.id, w]), ...d.stubs.map((s) => [s.id, s])])
  const before = index(prev), after = index(cur)
  const oldNightly = prev.nightly || {}, nightly = cur.nightly || {}
  if (nightly.finishedAt && nightly.finishedAt !== oldNightly.finishedAt && oldNightly.finishedAt !== undefined) {
    const failed = /^Failed/.test(nightly.summary || '')
    events.push({ title: failed ? 'Nightly run failed' : 'Nightly run succeeded', body: nightly.summary || '', tab: 'tests', tag: 'nightly', sticky: true, global: true })
  }
  const run = cur.lastRun, was = prev.lastRun
  const finished = (r) => r && ['done', 'failed', 'cancelled', 'stalled'].includes(r.status)
  if (finished(run) && prev.lastRun !== undefined && (!was || was.id !== run.id || !finished(was))) {
    const ok = run.status === 'done'
    events.push({ title: ok ? 'START WORKING run succeeded' : 'START WORKING run ' + (run.status === 'failed' ? 'failed' : run.status), body: run.summary || '', tab: 'stubs', tag: 'run', sticky: true, global: true })
  }
  for (const [id, x] of after) {
    const old = before.get(id), isWi = /^WI-/.test(id), tab = isWi ? 'work' : 'stubs'
    if (!old) events.push({ title: isWi ? id + ' was created' : 'New stub ' + id, body: x.title, tab, tag: id })
    else if (isWi && x.waiting && !old.waiting) events.push({ title: id + ' needs you', body: 'The run stopped to wait for a human step. Open the banner and press Resume when done.', tab, tag: id, sticky: true })
    else if (old.status !== x.status) events.push({ title: id + ' is ' + ((isWi ? NOTIFY_LABEL : NOTIFY_STUB)[x.status] || x.status), body: x.title, tab, tag: id, sticky: (isWi ? STICKY_WI : STICKY_STUB).has(x.status) })
    else if (x.ready && !old.ready) events.push({ title: id + ' is ready to enable', body: x.title, tab: 'stubs', tag: id, sticky: true })
  }
  return events
}

/** Many changes in one check (a big run) become one card: it stays if any of them needs attention, and lists those first. */
export function batchEvents(events, after = BATCH_AFTER) {
  if (events.length <= after) return events
  const needs = events.filter((e) => e.sticky), rest = events.filter((e) => !e.sticky)
  const lines = [...needs, ...rest].slice(0, 3).map((e) => e.title)
  const more = events.length - lines.length
  return [{
    title: events.length + ' updates in spec-web' + (needs.length ? ' (' + needs.length + ' need you)' : ''),
    body: lines.join('\n') + (more > 0 ? '\n+' + more + ' more' : ''),
    tab: (needs[0] || events[0]).tab, tag: 'batch', sticky: needs.length > 0, domain: events[0].domain,
  }]
}

/** Encrypts `payload` for one subscription (RFC 8291, single record). */
export function encryptPayload(payload, p256dh, auth) {
  const uaPublic = fromB64u(p256dh), authSecret = fromB64u(auth)
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey(), salt = randomBytes(16)
  const secret = ecdh.computeSecret(uaPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (only) record; the push services cap a message near 4 KB, ours are a few hundred bytes.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header[20] = asPublic.length
  return Buffer.concat([header, asPublic, body])
}

export function createPush({ file, subject = 'mailto:spec-web@example.com', fetchImpl = fetch }) {
  let state = { vapid: null, subs: [] }
  if (existsSync(file)) { try { state = { ...state, ...JSON.parse(readFileSync(file, 'utf8')) } } catch { /* unreadable: start over, clients resubscribe */ } }
  const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(state, null, 1)) }
  if (!state.vapid) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = publicKey.export({ format: 'jwk' })
    state.vapid = { privateJwk: privateKey.export({ format: 'jwk' }), publicKey: b64u(Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)])) }
    save()
  }
  const key = createPrivateKey({ key: state.vapid.privateJwk, format: 'jwk' })

  function vapidHeader(endpoint) {
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))
    const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
    const sig = sign('sha256', Buffer.from(head + '.' + claims), { key, dsaEncoding: 'ieee-p1363' })
    return `vapid t=${head}.${claims}.${b64u(sig)}, k=${state.vapid.publicKey}`
  }

  async function sendTo(sub, message) {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { authorization: vapidHeader(sub.endpoint), ttl: '86400', urgency: 'high', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream' },
      body: encryptPayload(JSON.stringify(message), sub.keys.p256dh, sub.keys.auth),
    })
    return res.status
  }

  return {
    publicKey: () => state.vapid.publicKey,
    count: () => state.subs.length,
    subscribe(sub, userAgent = '') {
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('not a push subscription')
      state.subs = state.subs.filter((s) => s.endpoint !== sub.endpoint)
      state.subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ua: String(userAgent).slice(0, 120), addedAt: Date.now() })
      save()
    },
    unsubscribe(endpoint) { state.subs = state.subs.filter((s) => s.endpoint !== endpoint); save() },
    /** Sends to every subscription; ones the push service says are gone (404/410) are dropped. */
    async broadcast(message) {
      const gone = new Set()
      await Promise.all(state.subs.map(async (s) => {
        try { const status = await sendTo(s, message); if (status === 404 || status === 410) gone.add(s.endpoint) } catch { /* offline: try next change */ }
      }))
      if (gone.size) { state.subs = state.subs.filter((s) => !gone.has(s.endpoint)); save() }
    },
  }
}
