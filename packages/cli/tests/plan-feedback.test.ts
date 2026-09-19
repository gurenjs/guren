import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FEEDBACK_MAX_BYTES, FEEDBACK_STDIN, readPlanFeedback, type PlanFeedback } from '../src/plan/feedback'

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

  /** One chunk per call, so a test can watch how far a read got before it stopped. */
  function chunked(chunks: readonly string[], produced?: { count: number }) {
    return async function* () {
      for (const chunk of chunks) {
        if (produced) produced.count += 1
        yield Buffer.from(chunk)
      }
    }
  }

  const fromStdin = (raw: string) => readPlanFeedback(FEEDBACK_STDIN, { stdin: chunked([raw]) })

  /** A valid feedback document of exactly `bytes` bytes, padded inside one comment. */
  function feedbackOfSize(bytes: number): string {
    const base = JSON.stringify({
      answers: [],
      elements: [{ elementId: 'model.comment', verdict: 'approve', comment: '' }],
    })
    const padding = bytes - Buffer.byteLength(base)
    return base.replace('"comment":""', () => `"comment":"${'x'.repeat(padding)}"`)
  }

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

  test('should report a pipe that failed as a feedback the command could not read', async () => {
    const failing = readPlanFeedback(FEEDBACK_STDIN, {
      // oxlint-disable-next-line require-yield -- a pipe that fails before its first chunk
      stdin: async function* () {
        throw new Error('EIO')
      },
    })

    await expect(failing).rejects.toThrow(/Cannot read the feedback on standard input: EIO/)
  })

  test('should read a document of exactly the limit', async () => {
    const feedback = await fromStdin(feedbackOfSize(FEEDBACK_MAX_BYTES))

    expect(Buffer.byteLength(JSON.stringify(feedback))).toBe(FEEDBACK_MAX_BYTES)
  })

  test('should refuse one byte past the limit, from a file and from a pipe', async () => {
    const tooBig = feedbackOfSize(FEEDBACK_MAX_BYTES + 1)

    await expect(readPlanFeedback(await writeFeedback(tooBig))).rejects.toThrow(/over the 5 MiB limit/)
    await expect(fromStdin(tooBig)).rejects.toThrow(/over the 5 MiB limit/)
  })

  test('should stop reading a pipe at the limit rather than at its end', async () => {
    const megabyte = 'x'.repeat(1024 * 1024)
    const produced = { count: 0 }

    const overrun = readPlanFeedback(FEEDBACK_STDIN, {
      stdin: chunked(
        Array.from({ length: 1000 }, () => megabyte),
        produced,
      ),
    })

    await expect(overrun).rejects.toThrow(/over the 5 MiB limit/)
    // The chunk that crosses the cap is the last one read, out of a gigabyte on offer.
    expect(produced.count).toBe(6)
  })
})
