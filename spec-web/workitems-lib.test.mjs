// Work item lifecycle (docs/spec/spec-work-items.md). Runs against a temp dir; nothing touches the real work items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const dir = mkdtempSync(resolve(tmpdir(), 'pw-work-'))
process.env.SPEC_WEB_WORK_DIR = dir
const W = await import('./workitems-lib.mjs')
const scratch = resolve(W.ROOT, '.test-work-tmp')

beforeAll(() => mkdirSync(scratch, { recursive: true }))
afterAll(() => { rmSync(dir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) })

describe('diffHunks', () => {
  it('reports only the changed lines with context', () => {
    const mid = Array.from({ length: 10 }, (_, i) => 'm' + i).join('\n')
    const a = `one\ntwo\nthree\n${mid}\nseven`
    const b = `one\ntwo\nTHREE\n${mid}\nseven\neight`
    const h = W.diffHunks(a, b)
    expect(h).toHaveLength(2)
    expect(W.diffStats(h)).toEqual({ added: 2, removed: 1 })
    expect(h[0].lines.filter((l) => l.t !== ' ').map((l) => l.t + l.s)).toEqual(['-three', '+THREE'])
  })
  it('is empty for equal text, ignoring line endings', () => {
    expect(W.diffHunks('a\r\nb', 'a\nb')).toEqual([])
  })
})

describe('collecting', () => {
  it('keeps the first baseline and drops an entry that returns to it', () => {
    W.recordEdit({ domain: 'app', doc: 'spec/x', before: 'a\nb', after: 'a\nB', by: 'Ana' })
    W.recordEdit({ domain: 'app', doc: 'spec/x', before: 'a\nB', after: 'a\nBB', by: 'Ben' })
    const [c] = W.collecting('app')
    expect(c.by).toEqual(['Ana', 'Ben'])
    expect(c.added).toBe(1)
    expect(c.removed).toBe(1)
    W.recordEdit({ domain: 'app', doc: 'spec/x', before: 'a\nBB', after: 'a\nb', by: 'Ana' })
    expect(W.collecting('app')).toEqual([])
  })
})

describe('work item lifecycle', () => {
  it('goes from the collection to done, gating integration on blocking questions', () => {
    expect(() => W.createFromCollection({ domain: 'app', by: 'Ana' })).toThrow(/no changes/i)
    W.recordEdit({ domain: 'app', doc: 'spec/games', title: 'Games', before: '# G\nold', after: '# G\nold\n- new rule for every game', by: 'Ana' })
    const wi = W.createFromCollection({ domain: 'app', by: 'Ana' })
    expect(wi.id).toBe('WI-1')
    expect(wi.status).toBe('collected')
    expect(wi.title).toMatch(/new rule/)
    expect(W.collecting('app')).toEqual([])

    W.attachRun(wi.id, 'analyze', 'run-x')
    expect(W.get(wi.id).status).toBe('analyzing')
    W.setAnalysis(wi.id, {
      summary: 'Applies to all games.', impact: [{ file: 'docs/spec/games.md', sections: 'each game', why: 'per-game take' }],
      questions: [{ text: 'Which games?', blocking: true }, { text: 'Show a toast? Default: no', blocking: false }],
    })
    expect(W.get(wi.id).status).toBe('questions')
    expect(() => W.startRewrite(wi.id, 'Ana')).toThrow(/blocking/)

    W.answer(wi.id, 1, 'All seven single-ball games', 'Ana')
    expect(W.get(wi.id).status).toBe('ready')          // the optional question stays open and does not hold it back
    expect(W.openQuestions(W.get(wi.id))).toHaveLength(1)

    const file = resolve(scratch, 'doc.md')
    writeFileSync(file, 'before\n')
    // Step 1: the spec text is rewritten, with no ticket yet; the work cannot start before a person confirms that text.
    expect(() => W.startWork(wi.id, 'Ana')).toThrow(/confirm the rewritten spec/)
    W.startRewrite(wi.id, 'Ana', [file])
    expect(W.get(wi.id).status).toBe('rewriting')
    writeFileSync(file, 'after, rewritten by Claude\n')
    expect(W.integrationDiff(wi.id).map((f) => f.file)).toEqual(['.test-work-tmp/doc.md'])   // what the review shows
    expect(() => W.markInQa(wi.id)).toThrow()
    W.markSpecReview(wi.id)
    expect(W.get(wi.id).status).toBe('spec-review')

    // The person asks for changes: back to ready with the comment, the original snapshot is kept for the next review.
    W.requestSpecChanges(wi.id, 'Move the rule under Dart Hit', 'Ben')
    expect(W.get(wi.id).status).toBe('ready')
    expect(W.get(wi.id).specFeedback.reason).toMatch(/Dart Hit/)
    W.startRewrite(wi.id, 'Ana', [file])
    expect(W.integrationDiff(wi.id)).toHaveLength(1)
    W.markSpecReview(wi.id)
    W.approveSpec(wi.id, 'Ben')
    expect(W.get(wi.id).status).toBe('approved')

    // Step 2: only now the work (tickets, development) starts.
    W.startWork(wi.id, 'Ana')
    expect(W.get(wi.id).status).toBe('working')
    W.linkStubs(wi.id, ['S-900', 'S-901'])
    W.markInQa(wi.id)
    W.setQaReport(wi.id, 'Tests: all green.')
    expect(W.get(wi.id).status).toBe('in-qa')

    // QA sends it back: the spec stays confirmed, so it returns to approved for another work pass.
    W.sendBack(wi.id, 'Dart Hit is missing it', 'Ben')
    expect(W.get(wi.id).status).toBe('approved')
    expect(W.get(wi.id).sentBack.reason).toMatch(/Dart Hit/)
    W.startWork(wi.id, 'Ana')
    W.markInQa(wi.id)
    const done = W.confirmDone(wi.id, 'Ben')
    expect(done.status).toBe('done')
    expect(done.stubIds).toEqual(['S-900', 'S-901'])
  })

  it('does not leave a work item stuck when a run ends without storing its result', () => {
    W.recordEdit({ domain: 'app', doc: 'spec/y', before: 'a', after: 'b', by: 'Ana' })
    const wi = W.createFromCollection({ domain: 'app', by: 'Ana' })
    expect(wi.id).toBe('WI-2')
    W.attachRun(wi.id, 'analyze', 'run-y')
    W.runFinished(wi.id, 'analyze', 'done')
    expect(W.get(wi.id).status).toBe('collected')
    expect(W.get(wi.id).lastError).toMatch(/without storing/)
    W.setAnalysis(wi.id, { summary: 'No questions.', impact: [], questions: [] })
    expect(W.get(wi.id).status).toBe('ready')
    W.startRewrite(wi.id, 'Ana', [])
    W.runFinished(wi.id, 'respec', 'failed')
    expect(W.get(wi.id).status).toBe('failed')
    expect(W.retry(wi.id).status).toBe('ready')                       // a failed rewrite retries as a rewrite
    W.startRewrite(wi.id, 'Ana', [])
    W.runFinished(wi.id, 'respec', 'done')                             // a silent finish still moves it to review
    expect(W.get(wi.id).status).toBe('spec-review')
    W.approveSpec(wi.id, 'Ben')
    W.startWork(wi.id, 'Ana')
    W.runFinished(wi.id, 'develop', 'failed')
    expect(W.get(wi.id).status).toBe('failed')
    expect(W.retry(wi.id).status).toBe('approved')                    // a failed development retries without redoing the review
  })

  it('a blocking question raised during the rewrite or the work stops it, and the answer resumes from the right step', () => {
    W.recordEdit({ domain: 'app', doc: 'spec/q', before: 'a', after: 'b', by: 'Ana' })
    const wi = W.createFromCollection({ domain: 'app', by: 'Ana' })
    W.setAnalysis(wi.id, { summary: 'ok', impact: [], questions: [] })
    W.startRewrite(wi.id, 'Ana', [])
    W.addQuestion(wi.id, 'Which value?', true)
    expect(W.get(wi.id).status).toBe('questions')
    W.answer(wi.id, 1, 'seven', 'Ana')
    expect(W.get(wi.id).status).toBe('ready')                          // not confirmed yet: rewrite again
    W.startRewrite(wi.id, 'Ana', [])
    W.markSpecReview(wi.id)
    W.approveSpec(wi.id, 'Ben')
    W.startWork(wi.id, 'Ana')
    W.addQuestion(wi.id, 'Another value?', true)
    expect(W.get(wi.id).status).toBe('questions')
    W.answer(wi.id, 2, 'nine', 'Ana')
    expect(W.get(wi.id).status).toBe('approved')                       // the spec stays confirmed: just start working again
  })
})

describe('documentation-only changes and the commit record', () => {
  it('keeps non-changes apart from the impact and records the run commit by commit', () => {
    W.recordEdit({ domain: 'app', doc: 'spec/z', before: 'x', after: 'x\nalready built behaviour', by: 'Ana' })
    const wi = W.createFromCollection({ domain: 'app', by: 'Ana' })
    W.setAnalysis(wi.id, {
      summary: 'One real change and one line that only documents what exists.',
      impact: [{ file: 'docs/spec/games.md', sections: 'Dart Hit', why: 'new rule' }],
      nonChanges: [{ file: 'docs/spec/trainer.md', sections: 'Settings', evidence: 'S-75 (done), src/components/trainer/SettingsTab.tsx' }, { file: '' }],
      questions: [],
    })
    const a = W.get(wi.id).analysis
    expect(a.impact).toHaveLength(1)
    expect(a.nonChanges).toEqual([{ file: 'docs/spec/trainer.md', sections: 'Settings', evidence: 'S-75 (done), src/components/trainer/SettingsTab.tsx' }])

    W.startRewrite(wi.id, 'Ana', [])
    expect(() => W.addCommit(wi.id, 'not-a-sha', 'docs', 'x')).toThrow(/sha/)
    expect(() => W.addCommit(wi.id, 'abc1234', 'misc', 'x')).toThrow(/kind/)
    expect(() => W.addCommit(wi.id, 'abc1234', 'docs', '  ')).toThrow(/subject/)
    W.addCommit(wi.id, 'abc1234', 'docs', 'docs(WI): document existing behaviour')
    W.addCommit(wi.id, 'def5678', 'spec', 'spec(WI): integrate the rule')
    W.addCommit(wi.id, 'ABC1234', 'docs', 'docs(WI): document existing behaviour')   // the same commit twice is ignored
    expect(W.get(wi.id).commits.map((c) => c.kind)).toEqual(['docs', 'spec'])
  })
})
