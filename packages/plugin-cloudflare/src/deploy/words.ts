/**
 * What the plan, the report and a failure's cleanup name, per backend: one table, so
 * a command spelled for one CLI never shows up in the other's output.
 */
import type { CloudflareBackend } from '../backend'

export interface BackendWords {
  cli: string
  /** The file a developer writes a resource id in. */
  config: string
  setSecret(name: string, worker: string): string
  /** The apply command as a person would type it, after the plan's arguments. */
  applyMigrations(args: string): string
  rollback(worker: string): string
  restore(database: { id: string; name: string }, bookmark: string): string
  delete(resource: { type: 'd1' | 'kv'; id: string; name: string }): string
}

export const BACKEND_WORDS: Record<CloudflareBackend, BackendWords> = {
  cf: {
    cli: 'cf',
    config: 'cloudflare.config.ts',
    setSecret: (name, worker) => `bunx cf workers secrets update ${name} --worker ${worker}`,
    applyMigrations: (args) => `cf d1 migrations apply <DB id> ${args}`,
    rollback: (worker) => `Roll back with \`bunx cf workers deployments list --worker ${worker}\` and a redeploy of an earlier version.`,
    restore: (database, bookmark) => `bunx cf d1 time-travel restore ${database.id} --bookmark ${bookmark}`,
    delete: (resource) => (resource.type === 'd1' ? `bunx cf d1 delete ${resource.id}` : `bunx cf kv namespaces delete ${resource.id}`),
  },
  wrangler: {
    cli: 'wrangler',
    config: 'wrangler.jsonc',
    setSecret: (name, worker) => `bunx wrangler secret put ${name} --name ${worker}`,
    applyMigrations: (args) => `wrangler d1 migrations apply <DB binding> ${args}`,
    rollback: (worker) => `Roll back to the previous version with \`bunx wrangler rollback --name ${worker}\`, or pass it an earlier version id.`,
    restore: (database, bookmark) => `bunx wrangler d1 time-travel restore ${database.name} --bookmark ${bookmark}`,
    delete: (resource) => (resource.type === 'd1' ? `bunx wrangler d1 delete ${resource.name}` : `bunx wrangler kv namespace delete --namespace-id ${resource.id}`),
  },
}
