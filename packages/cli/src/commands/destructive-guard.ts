import { CliError } from '../cli-error'

export function assertDestructiveCommandAllowed(force?: boolean): void {
  if (process.env.NODE_ENV === 'production' && !force) {
    throw new CliError('This command is destructive. Use --force to run in production.')
  }
}
