import { consola } from 'consola'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readIfExists } from './discovery'

const ENV_FILES = ['.env.example', '.env'] as const

/**
 * Appends a blueprint's env key to both env files. Both, because the scaffolder
 * copies `.env.example` to `.env` at create time: writing only the example
 * leaves the file the app actually reads without the key. The probe accepts a
 * commented-out line, so an app that already chose keeps its choice; a missing
 * file is left uncreated, since the app reads neither by a blueprint's doing.
 */
export async function appendEnvEntry(key: string, entry: string): Promise<void> {
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
      consola.info(`${file} already mentions ${key} — left unchanged.`)
      continue
    }

    await writeFile(resolve(process.cwd(), file), `${existing.trimEnd()}\n${entry}`, 'utf8')
    consola.info(`Added ${key} to ${file}.`)
  }
}
