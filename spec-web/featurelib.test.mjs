// Feature modules (docs/spec/feature-modules.md). Runs against a temp dir; nothing touches the real features.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dir = mkdtempSync(resolve(tmpdir(), 'pw-feat-'))
process.env.SPEC_WEB_FEATURES_DIR = dir
const F = await import('./featurelib.mjs')

beforeAll(() => F.scaffold('demo', 'Demo feature', 'A test'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('scaffold and read', () => {
  it('creates a listed feature with a starter spec', () => {
    expect(F.list().map((f) => f.id)).toContain('demo')
    expect(F.readSpec('demo')).toMatch(/^# Demo feature/)
  })
  it('refuses a bad id and an existing feature', () => {
    expect(() => F.scaffold('Bad Id', 'x')).toThrow(/lowercase/)
    expect(() => F.scaffold('demo', 'x')).toThrow(/already exists/)
  })
  it('never reads outside the features folder', () => {
    expect(() => F.readSpec('../etc')).toThrow(/No such feature/)
  })
  it('only trusts a local visuals path', () => {
    writeFileSync(resolve(dir, 'demo', 'feature.json'), JSON.stringify({ title: 'D', visuals: { src: '//evil.example/x', scenes: [{ id: 'a', title: 'A' }] } }))
    expect(F.meta('demo').visuals).toBeNull()
    writeFileSync(resolve(dir, 'demo', 'feature.json'), JSON.stringify({ title: 'D', visuals: { src: '/product/x/page', scenes: [{ id: 'a', title: 'A' }, { id: 'Bad Id', title: 'B' }] } }))
    expect(F.meta('demo').visuals.scenes.map((s) => s.id)).toEqual(['a'])
  })
})

describe('saving the spec', () => {
  it('needs a name and the current hash', () => {
    const v = F.view('demo')
    expect(() => F.saveSpec('demo', { content: 'x', base: v.hash, by: '' })).toThrow(/who you are/)
    expect(() => F.saveSpec('demo', { content: 'x', base: 'stale', by: 'Ann' })).toThrow(/changed since/)
  })
  it('records a timeline entry with the diff', () => {
    const v = F.view('demo')
    F.saveSpec('demo', { content: v.spec + '\n- A new rule\n', base: v.hash, by: 'Ann' })
    const t = F.view('demo').timeline[0]
    expect(t).toMatchObject({ kind: 'spec-edit', by: 'Ann' })
    expect(t.added).toBeGreaterThan(0)
  })
  it('saving identical text adds nothing to the timeline', () => {
    const v = F.view('demo')
    const n = v.timeline.length
    F.saveSpec('demo', { content: v.spec, base: v.hash, by: 'Ann' })
    expect(F.view('demo').timeline).toHaveLength(n)
  })
})

describe('questions, notes and the refine run', () => {
  it('collects answers and notes as pending', () => {
    F.addQuestion('demo', { text: 'How many?', blocking: true, by: 'Claude' })
    F.addQuestion('demo', { text: 'Optional?', by: 'Claude' })
    F.answerQuestion('demo', 1, 'Ten', 'Ann')
    F.addNote('demo', { text: 'Remember the edge case', by: 'Ann' })
    expect(F.view('demo').pending).toEqual({ answers: 1, notes: 1 })
  })
  it('keeps possible answers apart from the answer', () => {
    const q = F.addQuestion('demo', { text: 'Which?', options: ['  A  ', '', 'B'] })
    expect(q.options).toEqual(['A', 'B'])
    F.setQuestionOptions('demo', q.n, ['C'])
    const got = F.view('demo').questions.find((x) => x.n === q.n)
    expect(got.options).toEqual(['C'])
    expect(got.answer).toBeNull()
    expect(F.view('demo').pending.answers).toBe(1)
    F.removeQuestion('demo', q.n, 'Ann') // later tests count on exactly two questions
  })
  it('refuses to refine with nothing new, and answers need a name', () => {
    expect(() => F.answerQuestion('demo', 2, 'x', '')).toThrow(/who you are/)
    expect(() => F.addQuestion('demo', { text: '  ' })).toThrow(/Write the question/)
  })
  it('a finished run marks its input applied and records the spec diff', () => {
    F.startRefine('demo', 'Ann', 'run-1')
    expect(() => F.startRefine('demo', 'Ann', 'run-2')).toThrow(/already being updated/)
    // Claude edits the file directly while the run is going.
    writeFileSync(F.specFile('demo'), F.readSpec('demo') + '\n- Ten at most\n')
    F.finishRefine('demo', 'done', 'Added the limit')
    const v = F.view('demo')
    expect(v.pending).toEqual({ answers: 0, notes: 0 })
    expect(v.timeline[0]).toMatchObject({ kind: 'refine', by: 'Claude', text: 'Added the limit', added: 2 })
    expect(v.refine.status).toBe('done')
    expect(v.questions[0].appliedAt).toBeTruthy()
  })
  it('a failed run keeps the input pending', () => {
    F.answerQuestion('demo', 2, 'Yes', 'Ann')
    F.startRefine('demo', 'Ann', 'run-3')
    F.finishRefine('demo', 'failed', 'worker stopped')
    expect(F.view('demo').pending.answers).toBe(1)
    expect(F.view('demo').timeline[0].kind).toBe('refine-failed')
  })
  it('re-answering a question makes it pending again', () => {
    F.answerQuestion('demo', 1, 'Twelve', 'Bo')
    expect(F.view('demo').pending.answers).toBe(2)
  })
  it('removes notes and questions', () => {
    F.removeNote('demo', 1, 'Ann')
    F.removeQuestion('demo', 2, 'Ann')
    const v = F.view('demo')
    expect(v.notes).toHaveLength(0)
    expect(v.questions.map((q) => q.n)).toEqual([1])
  })
})

describe('work items', () => {
  it('the baseline is empty first, then the text last sent', () => {
    expect(F.workItemBaseline('demo')).toBe('')
    F.linkWorkItem('demo', { wi: 'WI-7', by: 'Ann', text: 'sent text' })
    expect(F.workItemBaseline('demo')).toBe('sent text')
    const v = F.view('demo')
    expect(v.workItems).toEqual([expect.objectContaining({ id: 'WI-7', by: 'Ann' })])
    expect(v.workItems[0].text).toBeUndefined()
  })
})
