import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const DEFAULT_SCHEMA = 'db/schema.ts'
const DEFAULT_OUTPUT = 'db/migrations'
const DRIZZLE_CONFIG_CANDIDATES = [
  'drizzle.config.ts',
  'drizzle.config.mts',
  'drizzle.config.js',
  'drizzle.config.mjs',
]

export interface MakeMigrationOptions {
  name?: string
  schema?: string
  out?: string
}

function toSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'migration'
}

async function resolveDrizzleConfig(): Promise<string | undefined> {
  const cwd = process.cwd()

  for (const candidate of DRIZZLE_CONFIG_CANDIDATES) {
    const absolute = resolve(cwd, candidate)
    try {
      await access(absolute)
      return candidate
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue
      }

      throw error
    }
  }

  return undefined
}

async function runCommand(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
    })

    child.on('error', (error) => {
      rejectPromise(error)
    })

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`drizzle-kit exited with code ${code}`))
      }
    })
  })
}

export async function makeMigration(options: MakeMigrationOptions = {}): Promise<void> {
  const name = options.name?.trim() ? toSlug(options.name) : undefined
  const configPath = await resolveDrizzleConfig()
  const hasOverrides = options.schema != null || options.out != null
  const useConfig = Boolean(configPath) && !hasOverrides

  const schema = options.schema ?? (useConfig ? undefined : DEFAULT_SCHEMA)
  const out = options.out ?? (useConfig ? undefined : DEFAULT_OUTPUT)

  const args = ['x', 'drizzle-kit', 'generate']

  if (schema) {
    args.push('--schema', schema)
  }

  if (out) {
    args.push('--out', out)
  }

  if (name) {
    args.push(`--name=${name}`)
  }

  if (useConfig && configPath) {
    args.push('--config', configPath)
  }

  const bunExecutable = process.execPath || 'bun'
  await runCommand(bunExecutable, args)
}
