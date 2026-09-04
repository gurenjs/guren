import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WriterOptions } from './utils'

/**
 * Shared primitives for official-plugin scaffolders. Unlike
 * `writeGeneratedFile`, an existing file is a silent skip rather than an
 * error — `guren plugin` must be re-runnable over an adopting project.
 */

/** Writes unless the file exists with different contents and no `--force`. */
export async function ensureScaffoldFile(relativePath: string, contents: string, options: WriterOptions = {}): Promise<boolean> {
  const absolutePath = resolve(process.cwd(), relativePath)

  let existing: string | undefined
  try {
    existing = await readFile(absolutePath, 'utf8')
  } catch {
    existing = undefined
  }

  if (existing === contents || (existing !== undefined && !options.force)) {
    return false
  }

  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, 'utf8')
  return true
}

/** Appends `entry` to the project's .gitignore unless already listed. */
export async function ensureGitignoreEntry(entry: string): Promise<boolean> {
  const gitignorePath = resolve(process.cwd(), '.gitignore')
  let content = ''

  try {
    content = await readFile(gitignorePath, 'utf8')
  } catch {
    content = ''
  }

  if (content.split(/\r?\n/u).includes(entry)) {
    return false
  }

  if (content && !content.endsWith('\n')) {
    content += '\n'
  }

  content += `${entry}\n`
  await writeFile(gitignorePath, content, 'utf8')
  return true
}
