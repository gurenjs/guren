import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readIfExists } from './discovery'

const ENV_FILES = ['.env.example', '.env'] as const

/**
 * Appends a blueprint's env key to both env files: the scaffolder copies
 * `.env.example` to `.env`, so writing only the example leaves the file the app
 * reads without the key. A commented-out line counts as a choice already made,
 * and a missing file is left uncreated. `expected` is the value this blueprint
 * made work — an app assigning another keeps it and is told.
 */
export async function appendEnvEntry(key: string, entry: string, expected?: string): Promise<void> {
  // An entry not assigning `key` never satisfies the probe, so every run would
  // append it again; `key` reaches a regex, so callers pass a literal name.
  if (!new RegExp(`^\\s*${key}=`, 'm').test(entry)) {
    throw new Error(`The env entry for ${key} does not assign ${key}=.`)
  }

  const declared = new RegExp(`^\\s*#?\\s*${key}=`, 'm')

  for (const file of ENV_FILES) {
    const existing = await readIfExists(process.cwd(), file)
    if (existing === null) continue

    if (declared.test(existing)) {
      const assigned = new RegExp(`^\\s*${key}=(\\S*)`, 'm').exec(existing)?.[1]
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
}
