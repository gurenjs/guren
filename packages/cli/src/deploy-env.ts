/**
 * The variables a production deploy must provide (RFC 0035 §5): the keys of
 * `config/env.ts` that resolve to unset when nothing is set and `NODE_ENV` is
 * `production`. `EnvVar` exposes no presence, so the schema is parsed rather than
 * read: `.optional()`, `.default()` and `.requiredInProduction()` mean what they
 * mean at boot. The deploy plugins read it through `@guren/core/internal/deploy-plan`.
 */
import { loadEnvSchema } from './app-env'

export type RequiredDeployEnv =
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable'; readonly message: string }
  | { readonly status: 'loaded'; readonly required: readonly string[] }

export async function requiredDeployEnv(cwd: string): Promise<RequiredDeployEnv> {
  const loaded = await loadEnvSchema(cwd)
  if (loaded.status !== 'loaded') return loaded

  // `parse()` falls back to `process.env` for a key the source lacks, and reads
  // NODE_ENV from it, so both are set aside for one synchronous call.
  const keys = [...Object.keys(loaded.vars), 'NODE_ENV']
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
  process.env.NODE_ENV = 'production'
  try {
    const { unset } = loaded.schema.parse(undefined, { mode: 'report' })
    return { status: 'loaded', required: [...unset].sort() }
  } catch (error) {
    return { status: 'unreadable', message: `config/env.ts failed to parse: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
