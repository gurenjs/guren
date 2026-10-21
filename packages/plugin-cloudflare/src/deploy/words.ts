/**
 * What the plan, the report and a failure's cleanup name, per backend: one table, so
 * a command spelled for one CLI never shows up in the other's output.
 */
import type { CloudflareBackend } from '../backend'
import { WRANGLER_DEPLOY_CONFIG_FILE, WRANGLER_OUTPUT_DIR } from '../worker-manifest'

export interface BackendWords {
  cli: string
  /** The file a developer writes a resource id in. */
  config: string
  setSecret(name: string, worker: string): string
  /** The apply command as a person would type it, after the plan's arguments. */
  applyMigrations(args: string): string
  rollback(worker: string): string
  restore(database: CleanupTarget, bookmark: string): string
  delete(resource: CleanupTarget & { type: 'd1' | 'kv' | 'r2' }): string
  /** The fix for an R2 binding a disk reads and the Worker lacks. */
  addR2(binding: string, bucket: string): string
  /** The fix for a D1 binding config/database.ts names and the Worker lacks. */
  addD1(binding: string): string
}

/** What a cleanup command addresses a resource by: cf by id; Wrangler by binding, through the deploy config. */
interface CleanupTarget {
  binding: string
  id: string
  name: string
}

/** The rendered config holds the resolved ids, so a placeholder id in wrangler.jsonc never stands in. */
const DEPLOY_CONFIG = `-c ${WRANGLER_OUTPUT_DIR}/${WRANGLER_DEPLOY_CONFIG_FILE}`

export const BACKEND_WORDS: Record<CloudflareBackend, BackendWords> = {
  cf: {
    cli: 'cf',
    config: 'cloudflare.config.ts',
    setSecret: (name, worker) => `bunx cf workers secrets update ${name} --worker ${worker}`,
    applyMigrations: (args) => `cf d1 migrations apply <DB id> ${args}`,
    rollback: (worker) => `Roll back with \`bunx cf workers deployments list --worker ${worker}\` and a redeploy of an earlier version.`,
    restore: (database, bookmark) => `bunx cf d1 time-travel restore ${database.id} --bookmark ${bookmark}`,
    delete: (resource) => (resource.type === 'd1'
      ? `bunx cf d1 delete ${resource.id}`
      : resource.type === 'kv' ? `bunx cf kv namespaces delete ${resource.id}` : `bunx cf r2 buckets delete ${resource.name}`),
    addR2: (binding) => `gurenWorker() binds ${binding} from the build; an env entry after the spread in cloudflare.config.ts replaced it. Remove that entry, or bind ${binding} with bindings.r2().`,
    addD1: (binding) => `gurenWorker() binds the database as DB. Pass binding: 'DB' to createD1Database() in config/database.ts, or bind ${binding} in cloudflare.config.ts.`,
  },
  wrangler: {
    cli: 'wrangler',
    config: 'wrangler.jsonc',
    setSecret: (name, worker) => `bunx wrangler secret put ${name} --name ${worker}`,
    applyMigrations: (args) => `wrangler d1 migrations apply <DB binding> ${args}`,
    rollback: (worker) => `Roll back to the previous version with \`bunx wrangler rollback --name ${worker}\`, or pass it an earlier version id.`,
    restore: (database, bookmark) => `bunx wrangler d1 time-travel restore ${database.binding} --bookmark ${bookmark} ${DEPLOY_CONFIG}`,
    delete: (resource) => (resource.type === 'd1'
      ? `bunx wrangler d1 delete ${resource.binding} ${DEPLOY_CONFIG}`
      : resource.type === 'kv' ? `bunx wrangler kv namespace delete --namespace-id ${resource.id}` : `bunx wrangler r2 bucket delete ${resource.name}`),
    addR2: (binding, bucket) => `Add it to wrangler.jsonc: "r2_buckets": [{ "binding": "${binding}", "bucket_name": "${bucket}" }].`,
    addD1: (binding) => `Add a d1_databases entry with "binding": "${binding}" to wrangler.jsonc, or name the existing binding in config/database.ts.`,
  },
}
