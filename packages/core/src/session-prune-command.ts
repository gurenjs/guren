import { Command, getContainer, type SessionManager } from '@guren/server'

/**
 * Console sweeper for session stores (RFC 0020 §2). `read()` already treats an
 * expired session as missing, so this only keeps the table from growing;
 * schedule it. Stores that cannot sweep (Redis expires its own keys) are
 * skipped by the manager.
 */
export class SessionsPruneCommand extends Command {
  static override signature = 'sessions:prune'

  static override description = 'Delete expired sessions from the configured session stores'

  async handle(): Promise<void> {
    const manager = getContainer().makeOptional<SessionManager>('session')
    // Thrown, not reported: a sweep that found no store to sweep must not
    // exit 0 on a schedule nobody reads.
    if (!manager) {
      throw new Error(
        'sessions:prune requires a session manager. Register a provider that binds createSessionManager(sessionConfig) as `session` (run `bunx guren add session`).',
      )
    }

    await manager.pruneExpired()
    this.info('Expired sessions removed.')
  }
}
