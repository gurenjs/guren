import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { WriterOptions } from './utils'

/**
 * Shared primitives for official-plugin scaffolders (`plugin-vercel.ts`,
 * `plugin-lambda.ts`). Unlike `writeGeneratedFile`, an existing file is a
 * silent skip rather than an error — `guren plugin` must be re-runnable over
 * a project that already adopted the plugin.
 */

/**
 * Write `contents` to `relativePath` (under cwd) unless the file already
 * exists with different contents and `--force` was not passed. Returns
 * whether the file was written.
 */
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

/**
 * Append `entry` to the project's .gitignore unless already listed. Returns
 * whether the file was modified.
 */
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
