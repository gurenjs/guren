import { Command, type OAuthManager } from '@guren/server'

/**
 * Console sweeper for the OAuth state store. `handleCallback()` already rejects
 * an expired state, so this only keeps the table from growing; schedule it. A
 * flow abandoned before the callback is never looked up again, so its row is
 * only removed here. Stores that expire their own entries (Redis, memory) are
 * skipped by the manager.
 */
export class OAuthStatesPruneCommand extends Command {
  static override signature = 'oauth-states:prune'

  static override description = 'Delete expired OAuth states from the configured state store'

  async handle(): Promise<void> {
    const manager = this.resolveOptional<OAuthManager>('oauth')
    // Thrown, not reported: a sweep that found no store to sweep must not
    // exit 0 on a schedule nobody reads.
    if (!manager) {
      throw new Error(
        'oauth-states:prune requires an OAuth manager. Register a provider that binds createOAuthManager({ stateStore }) as `oauth` (run `bunx guren add oauth`).',
      )
    }

    await manager.pruneExpiredStates()
    this.info('Expired OAuth states removed.')
  }
}
