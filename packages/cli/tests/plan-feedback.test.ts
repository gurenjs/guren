import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FEEDBACK_STDIN, readPlanFeedback, type PlanFeedback } from '../src/plan/feedback'

/** The document the page exports, with one element of each shape it writes. */
const FEEDBACK: PlanFeedback = {
  planHash: 'a'.repeat(64),
  answers: [{ questionId: 'Q-delete', option: 'soft' }, { questionId: 'Q-rate', text: 'ask the team' }],
  elements: [
    { elementId: 'model.comment', verdict: 'approve', comment: '' },
    { elementId: 'route.comments.store', verdict: 'changes', comment: 'require a policy' },
    { elementId: 'view.posts.show', verdict: null, comment: 'the empty state reads oddly' },
  ],
}

describe('readPlanFeedback', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-plan-feedback-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function writeFeedback(document: unknown): Promise<string> {
    const path = join(dir, 'feedback.json')
    await writeFile(path, typeof document === 'string' ? document : JSON.stringify(document), 'utf8')
    return path
  }

  const fromStdin = (raw: string) => readPlanFeedback(FEEDBACK_STDIN, { stdin: async () => raw })

  test('should read a feedback file', async () => {
    const feedback = await readPlanFeedback(await writeFeedback(FEEDBACK))

    expect(feedback).toEqual(FEEDBACK)
  })

  test('should resolve a relative path against the working directory it is given', async () => {
    await writeFeedback(FEEDBACK)

    expect(await readPlanFeedback('feedback.json', { cwd: dir })).toEqual(FEEDBACK)
  })

  test('should read the document from standard input', async () => {
    expect(await fromStdin(JSON.stringify(FEEDBACK))).toEqual(FEEDBACK)
  })

  test('should keep an element carrying only a comment', async () => {
    const feedback = await fromStdin(JSON.stringify(FEEDBACK))

    // The page exports a commented element with no verdict, and dropping the null
    // would take the comment with it.
    expect(feedback.elements[2]).toEqual({
      elementId: 'view.posts.show',
      verdict: null,
      comment: 'the empty state reads oddly',
    })
  })

  test('should report a document that is not JSON with the path that failed', async () => {
    const path = await writeFeedback('not json')

    await expect(readPlanFeedback(path)).rejects.toThrow(new RegExp(`${path}.*not valid JSON`))
  })

  test('should refuse a verdict the page never issues', async () => {
    const document = { ...FEEDBACK, elements: [{ elementId: 'model.comment', verdict: 'reject', comment: '' }] }

    await expect(readPlanFeedback(await writeFeedback(document))).rejects.toThrow(/elements\.0\.verdict/)
  })

  test('should refuse a document missing the sections the page exports', async () => {
    await expect(readPlanFeedback(await writeFeedback({ elements: [] }))).rejects.toThrow(/answers/)
  })

  test('should report a pipe that carried nothing', async () => {
    await expect(fromStdin('')).rejects.toThrow(/No feedback arrived on standard input/)
  })

  test('should report a file that is not there', async () => {
    await expect(readPlanFeedback(join(dir, 'missing.json'))).rejects.toThrow(/Cannot read the feedback/)
  })
})
