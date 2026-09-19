/**
 * The review feedback the rendered plan exports, read back (RFC 0030 §4).
 *
 * The document is written by the page and carried here by hand, so it is parsed
 * against a schema rather than trusted: `guren plan --revise` turns it into model
 * input. `-` reads standard input, which is what the page's "Copy feedback" and a
 * pipe replace the file with.
 */

import { createReadStream } from 'node:fs'
import { resolve } from 'node:path'

import { z } from 'zod'

import { CliError, formatSchemaIssues } from '../cli-error'

export const FEEDBACK_STDIN = '-'

/**
 * Feedback is one comment per plan element, which stays under a megabyte however
 * long the comments are. The cap is what stops a log or a binary piped in by
 * mistake, so it is read as bytes and refused before the document is.
 */
export const FEEDBACK_MAX_BYTES = 5 * 1024 * 1024

/**
 * The verdicts the page issues. `null` is an element someone commented on without
 * judging: the page exports it, and dropping it here would lose the comment.
 */
export const PLAN_FEEDBACK_VERDICTS = ['approve', 'changes'] as const

export const PlanFeedbackSchema = z.object({
  /** Absent on a draft, which has no baseline and so no hash. */
  planHash: z.string().optional(),
  answers: z.array(
    z.object({
      questionId: z.string(),
      option: z.string().optional(),
      text: z.string().optional(),
    }),
  ),
  elements: z.array(
    z.object({
      elementId: z.string(),
      verdict: z.enum(PLAN_FEEDBACK_VERDICTS).nullable(),
      comment: z.string(),
    }),
  ),
})

export type PlanFeedback = z.infer<typeof PlanFeedbackSchema>

export interface ReadPlanFeedbackOptions {
  cwd?: string
  /** Test seam: where {@link FEEDBACK_STDIN} reads from. */
  stdin?: () => AsyncIterable<Uint8Array>
}

function overSizeMessage(origin: string): string {
  return `The feedback on ${origin} is over the ${FEEDBACK_MAX_BYTES / 1024 / 1024} MiB limit.`
}

/**
 * Every source counted as it arrives: throwing out of the loop closes the iterator,
 * so a stream that would not end costs the cap rather than everything it has to
 * offer. A file is read the same way rather than measured first, since a size read
 * before the open describes whatever the path pointed at then, and a FIFO or a
 * `/proc` file reports none at all.
 */
async function readWithinLimit(chunks: AsyncIterable<Uint8Array>, origin: string): Promise<string> {
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0

  for await (const chunk of chunks) {
    bytes += chunk.byteLength
    if (bytes > FEEDBACK_MAX_BYTES) throw new CliError(overSizeMessage(origin))
    parts.push(decoder.decode(chunk, { stream: true }))
  }

  parts.push(decoder.decode())
  return parts.join('')
}

/** The feedback document, or a CliError naming what about it could not be read. */
export async function readPlanFeedback(source: string, options: ReadPlanFeedbackOptions = {}): Promise<PlanFeedback> {
  const fromStdin = source === FEEDBACK_STDIN
  const origin = fromStdin ? 'standard input' : resolve(options.cwd ?? process.cwd(), source)

  let raw: string
  try {
    const chunks = fromStdin ? (options.stdin ?? (() => process.stdin))() : createReadStream(origin)
    raw = await readWithinLimit(chunks, origin)
  } catch (error) {
    // The cap is already an answer about the feedback; only a failed read needs one.
    if (error instanceof CliError) throw error
    throw new CliError(`Cannot read the feedback on ${origin}: ${(error as Error).message}`)
  }

  // An empty read is the common shape of a pipe whose producer wrote nothing, and
  // `JSON.parse('')` answers it with a position no one can act on.
  if (raw.trim() === '') throw new CliError(`No feedback arrived on ${origin}.`)

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch (error) {
    throw new CliError(`The feedback on ${origin} is not valid JSON: ${(error as Error).message}`)
  }

  const parsed = PlanFeedbackSchema.safeParse(document)
  if (!parsed.success) {
    throw new CliError(
      `The feedback on ${origin} does not match the feedback the plan page exports:\n${formatSchemaIssues(parsed.error)}`,
    )
  }
  return parsed.data
}
