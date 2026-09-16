import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { declareEnvEntries, ENV_SCHEMA_FILE } from './app-env'
import { readIfExists } from './discovery'

const ENV_FILES = ['.env.example', '.env'] as const

export interface AppendEnvEntryOptions {
  /** The value this blueprint made work; an app assigning another keeps it and is told. */
  readonly expected?: string
  /** Also declare the key in `config/env.ts` (RFC 0027 §1), defaulting to the value `entry` assigns. */
  readonly declare?: boolean
}

/**
 * Appends a blueprint's env key to `.env.example` and `.env`: the app reads the
 * latter, a commented-out line counts as a choice already made, and a missing
 * file is left uncreated.
 */
export async function appendEnvEntry(key: string, entry: string, options: AppendEnvEntryOptions = {}): Promise<void> {
  const { expected } = options
  // Two patterns, not one: a file may both mention `key` in a comment and
  // assign it further down, and it is the assignment the app reads.
  // `key` reaches a regex, so callers pass a literal name.
  const assignment = new RegExp(`^\\s*${key}=(\\S*)`, 'm')
  const declared = new RegExp(`^\\s*#?\\s*${key}=`, 'm')

  // An entry not assigning `key` never satisfies the probe, so every run would
  // append it again.
  const value = assignment.exec(entry)?.[1]
  if (value === undefined) {
    throw new Error(`The env entry for ${key} does not assign ${key}=.`)
  }

  let exampleCommentsItOut = false
  for (const file of ENV_FILES) {
    const existing = await readIfExists(process.cwd(), file)
    if (existing === null) continue

    if (declared.test(existing)) {
      const assigned = assignment.exec(existing)?.[1]
      if (assigned === undefined && file === '.env.example') exampleCommentsItOut = true
      if (expected !== undefined && assigned !== undefined && assigned !== expected) {
        consola.warn(
          `${file} already sets ${key}=${assigned}, so what this installed (${expected}) is not what the app will use.`,
        )
      } else {
        consola.info(`${file} already mentions ${key} — left unchanged.`)
      }
      continue
    }

    await writeFile(resolve(process.cwd(), file), `${existing.trimEnd()}\n${entry}`, 'utf8')
    consola.info(`Added ${key} to ${file}.`)
  }

  // Declaring a key the example only comments out would fail `guren check --env`,
  // which requires the example to assign every declared key.
  if (!options.declare || exampleCommentsItOut) return

  const { unpatched } = await declareEnvEntries([{ key, ...(value === '' ? {} : { default: value }) }])
  if (unpatched.length > 0) {
    consola.warn(`Could not declare ${key} in ${ENV_SCHEMA_FILE} — add it to the defineEnv({ ... }) call by hand.`)
  }
}
