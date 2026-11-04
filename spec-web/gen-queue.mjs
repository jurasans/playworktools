/**
 * One ordered view over the two generation queues (Space Chase art + audio). They run on the same GPU one job at a time, so the
 * Images and Audio tabs show the same list and reorder it; tools/generate/gen-queue-runner.mjs takes jobs from here in this order.
 * A job's `priority` is a number, lowest first; a new job defaults to its creation time in ms, so the order is first-in-first-out
 * until someone moves a job (moving renumbers every queued job 0..n).
 */
import { readImageQueue, updateImageQueue } from './images-lib.mjs'
import { readQueue, updateQueue } from './audio-lib.mjs'

const prio = (j) => (typeof j.priority === 'number' ? j.priority : Date.parse(j.createdAt) || 0)

const row = (kind, j) => ({
  kind, id: j.id, status: j.status, count: j.count, createdAt: j.createdAt, startedAt: j.startedAt,
  label: kind === 'image' ? j.asset : j.name, priority: prio(j),
})

/** Running jobs first, then the queued ones in the order they will run. */
export async function listGenQueue() {
  const [img, aud] = await Promise.all([readImageQueue(), readQueue()])
  const all = [...img.jobs.map((j) => row('image', j)), ...aud.jobs.map((j) => row('audio', j))]
  const running = all.filter((r) => r.status === 'running').sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))
  const queued = all.filter((r) => r.status === 'queued').sort((a, b) => a.priority - b.priority || String(a.createdAt).localeCompare(String(b.createdAt)))
  return { running, queued }
}

export async function nextQueuedJob() {
  return (await listGenQueue()).queued[0] || null
}

/** Moves a queued job one place earlier ('up') or to the front ('top'). Returns the new queued order, or null if the job is not queued. */
export async function moveGenJob(kind, id, how) {
  const { queued } = await listGenQueue()
  const i = queued.findIndex((r) => r.kind === kind && r.id === id)
  if (i < 0) return null
  const order = queued.slice()
  const [item] = order.splice(i, 1)
  order.splice(how === 'top' ? 0 : Math.max(0, i - 1), 0, item)
  const rank = new Map(order.map((r, n) => [`${r.kind}:${r.id}`, n]))
  const apply = (kindName) => (q) => { for (const j of q.jobs) { const n = rank.get(`${kindName}:${j.id}`); if (n !== undefined && j.status === 'queued') j.priority = n } }
  await updateImageQueue(apply('image'))
  await updateQueue(apply('audio'))
  return listGenQueue()
}
