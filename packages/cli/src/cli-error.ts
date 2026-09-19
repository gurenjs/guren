/**
 * A failure the user caused and can fix from its message alone, so `runCli`
 * prints the message without a stack trace. Anything else keeps its stack,
 * since an unexpected throw is a bug report.
 */
import type { z } from 'zod'

export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}

/** A schema failure as the lines a {@link CliError} message carries it in. */
export function formatSchemaIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('\n')
}
