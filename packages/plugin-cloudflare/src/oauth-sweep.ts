/**
 * The OAuth provider's KV garbage collection, run from a cron trigger.
 *
 * KV TTLs drop the records that expire. Nothing drops the ones that cannot: a
 * grant orphaned by a deleted client carries no `expiresAt` at all, and
 * `purgeExpiredData` is the only thing that removes it — the provider never
 * calls it itself.
 */
import type { WorkersScheduledEvent } from './boot'

/** Only what this sweep calls, so `@cloudflare/workers-types` stays a devDependency. */
export interface OAuthSweepKvLike {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

/** The provider binding the sweep reads, fixed by `OAuthProvider`. */
export interface OAuthSweepEnv {
  OAUTH_KV: OAuthSweepKvLike
}

export interface OAuthPurgeOptions {
  batchSize?: number
  purgeOrphanedGrants?: boolean
  purgeExpiredGrants?: boolean
  purgeOrphanedTokens?: boolean
}

/** `done` is false when the pass stopped at `batchSize` with keys left over. */
export interface OAuthPurgeResult {
  done: boolean
}

/**
 * Structural view of `OAuthProvider`, which is a devDependency: the sweep is
 * handed the instance the generated worker constructs, never its class.
 */
export interface OAuthPurgerLike<Env> {
  purgeExpiredData(env: Env, options?: OAuthPurgeOptions): Promise<OAuthPurgeResult>
}

/** Under a prefix the provider never lists — it lists `client:`, `grant:` and `token:` only. */
export const OAUTH_PURGE_MARKER = 'guren:oauth-purge:last'

/**
 * How often to sweep, independent of the cron the app declares. The trigger
 * belongs to the app and the build scaffolds none, so no cadence may be assumed
 * and `event.cron` cannot be matched against.
 */
export const OAUTH_PURGE_INTERVAL_MS = 3_600_000

/**
 * The depth of the only window ever swept, not a throughput knob: the provider's
 * cursor lives inside one call and `PurgeOptions` carries none, so every firing
 * restarts at the head of the key space and records past this many are never
 * reached. Sized for Free's 50 subrequests per invocation (Paid allows 10000, and
 * a worker cannot tell which it is on); KV reads count, as do the app's own tasks.
 */
export const OAUTH_PURGE_BATCH = 15

/**
 * Sweep `oauth`'s KV, at most once per `OAUTH_PURGE_INTERVAL_MS`.
 *
 * Never throws: a cron firing runs the app's own scheduled tasks after this, and
 * they still have to be reached. A failed sweep is reported through `logger`.
 */
export async function sweepOAuthStorage<Env extends OAuthSweepEnv>(
  oauth: OAuthPurgerLike<Env>,
  event: WorkersScheduledEvent,
  env: Env,
  logger: Pick<Console, 'warn' | 'error'> = console,
): Promise<void> {
  // The minute the trigger was meant for, matching how tasks are dispatched.
  const now = event.scheduledTime ?? Date.now()

  try {
    const last = await env.OAUTH_KV.get(OAUTH_PURGE_MARKER)
    const elapsed = now - Number(last)
    // `elapsed >= 0` as well: a marker dated ahead of now, from clock skew or a
    // key written by hand, would otherwise skip every firing from then on.
    if (last && elapsed >= 0 && elapsed < OAUTH_PURGE_INTERVAL_MS) return

    // Claimed before the sweep, not after: a sweep that dies part-way — running
    // out of subrequests is the way it will — then waits out the interval rather
    // than retrying on every firing. Still only on the firings that sweep, so a
    // per-minute cron writes this hourly and not 1440 times a day.
    await env.OAUTH_KV.put(OAUTH_PURGE_MARKER, String(now))

    // One call per pass, for the same total reads as one call for both. The
    // provider returns as soon as the grant pass fills its budget, so an app
    // holding more grants than OAUTH_PURGE_BATCH never reaches the token pass
    // behind it — orphaned tokens would then accumulate exactly as grants did.
    const grants = await oauth.purgeExpiredData(env, {
      batchSize: OAUTH_PURGE_BATCH,
      purgeOrphanedTokens: false,
    })
    const tokens = await oauth.purgeExpiredData(env, {
      batchSize: OAUTH_PURGE_BATCH,
      purgeOrphanedGrants: false,
      purgeExpiredGrants: false,
    })

    if (!grants.done || !tokens.done) {
      logger.warn('OAuth sweep stopped at its batch limit; records past it stay unswept.', grants, tokens)
    }
  } catch (error) {
    logger.error('OAuth storage sweep failed.', error)
  }
}
