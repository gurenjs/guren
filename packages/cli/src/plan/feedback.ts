/**
 * The review feedback the rendered plan exports, read back (RFC 0030 §4).
 *
 * The document is written by the page and carried here by hand, so it is parsed
 * against a schema rather than trusted. `plan:revise` reads it for its locks and
 * answers; turning its comments into ops is the model-calling `plan --revise`'s work.
 * `-` reads standard input, which the page's "Copy feedback" and a pipe replace the file
 * with. `plan:revise` reads its ops and edited plans through the same counting reader.
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

export interface ReadJsonWithinLimitOptions extends ReadPlanFeedbackOptions {
  /** What the document is, as the messages name it: `feedback`, `ops`. */
  what: string
}

function overSizeMessage(what: string, origin: string): string {
  return `The ${what} on ${origin} is over the ${FEEDBACK_MAX_BYTES / 1024 / 1024} MiB limit.`
}

/**
 * Every source counted as it arrives: throwing out of the loop closes the iterator,
 * so a stream that would not end costs the cap rather than everything it has to
 * offer. A file is read the same way rather than measured first, since a size read
 * before the open describes whatever the path pointed at then, and a FIFO or a
 * `/proc` file reports none at all.
 */
async function readWithinLimit(chunks: AsyncIterable<Uint8Array>, what: string, origin: string): Promise<string> {
  const decoder = new TextDecoder()
  const parts: string[] = []
  let bytes = 0

  for await (const chunk of chunks) {
    bytes += chunk.byteLength
    if (bytes > FEEDBACK_MAX_BYTES) throw new CliError(overSizeMessage(what, origin))
    parts.push(decoder.decode(chunk, { stream: true }))
  }

  parts.push(decoder.decode())
  return parts.join('')
}

/** A JSON document from a file or `-`, under the cap; `raw` is the text as read. Every failure is a CliError. */
export async function readJsonWithinLimit(
  source: string,
  options: ReadJsonWithinLimitOptions,
): Promise<{ document: unknown; raw: string; origin: string }> {
  const { what } = options
  const fromStdin = source === FEEDBACK_STDIN
  const origin = fromStdin ? 'standard input' : resolve(options.cwd ?? process.cwd(), source)

  let raw: string
  try {
    const chunks = fromStdin ? (options.stdin ?? (() => process.stdin))() : createReadStream(origin)
    raw = await readWithinLimit(chunks, what, origin)
  } catch (error) {
    // The cap is already an answer about the document; only a failed read needs one.
    if (error instanceof CliError) throw error
    throw new CliError(`Cannot read the ${what} on ${origin}: ${(error as Error).message}`)
  }

  // An empty read is the common shape of a pipe whose producer wrote nothing, and
  // `JSON.parse('')` answers it with a position no one can act on.
  if (raw.trim() === '') throw new CliError(`No ${what} arrived on ${origin}.`)

  try {
    return { document: JSON.parse(raw) as unknown, raw, origin }
  } catch (error) {
    throw new CliError(`The ${what} on ${origin} is not valid JSON: ${(error as Error).message}`)
  }
}

/** The feedback document, or a CliError naming what about it could not be read. */
export async function readPlanFeedback(source: string, options: ReadPlanFeedbackOptions = {}): Promise<PlanFeedback> {
  const { document, origin } = await readJsonWithinLimit(source, { ...options, what: 'feedback' })
  const parsed = PlanFeedbackSchema.safeParse(document)
  if (!parsed.success) {
    throw new CliError(
      `The feedback on ${origin} does not match the feedback the plan page exports:\n${formatSchemaIssues(parsed.error)}`,
    )
  }
  return parsed.data
}
