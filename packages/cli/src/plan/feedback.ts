/**
 * The review feedback the rendered plan exports, read back (RFC 0030 §4).
 *
 * The document is written by the page and carried here by hand, so it is parsed
 * against a schema rather than trusted: `guren plan --revise` turns it into model
 * input. `-` reads standard input, which is what the page's "Copy feedback" and a
 * pipe replace the file with.
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { text } from 'node:stream/consumers'

import { z } from 'zod'

import { CliError } from '../cli-error'

export const FEEDBACK_STDIN = '-'

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
  stdin?: () => Promise<string>
}

function readStdin(): Promise<string> {
  return text(process.stdin)
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n')
}

/** The feedback document, or a CliError naming what about it could not be read. */
export async function readPlanFeedback(source: string, options: ReadPlanFeedbackOptions = {}): Promise<PlanFeedback> {
  const fromStdin = source === FEEDBACK_STDIN
  const origin = fromStdin ? 'standard input' : resolve(options.cwd ?? process.cwd(), source)

  let raw: string
  try {
    raw = fromStdin ? await (options.stdin ?? readStdin)() : await readFile(origin, 'utf8')
  } catch (error) {
    const where = fromStdin ? 'on standard input' : `at ${origin}`
    throw new CliError(`Cannot read the feedback ${where}: ${(error as Error).message}`)
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
      `The feedback on ${origin} does not match the feedback the plan page exports:\n${formatIssues(parsed.error)}`,
    )
  }
  return parsed.data
}
