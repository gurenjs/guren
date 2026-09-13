/**
 * A failure the user caused and can fix from its message alone, so `runCli`
 * prints the message without a stack trace. Anything else keeps its stack,
 * since an unexpected throw is a bug report.
 */
export class CliError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliError'
  }
}
