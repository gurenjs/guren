import { consola } from 'consola'

export function ensureDestructiveCommandAllowed(force?: boolean): boolean {
  if (process.env.NODE_ENV === 'production' && !force) {
    consola.error('This command is destructive. Use --force to run in production.')
    process.exit(1)
    return false
  }

  return true
}
