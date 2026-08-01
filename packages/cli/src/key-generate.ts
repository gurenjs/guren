import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { generateAppKey } from '@guren/server'

export function generateKeyValue(): string {
  return generateAppKey()
}

export async function writeKeyToEnv(cwd: string, key: string): Promise<void> {
  const path = resolve(cwd, '.env')
  let content = ''

  try {
    content = await readFile(path, 'utf8')
  } catch {
    content = ''
  }

  const line = `APP_KEY=${key}`
  const next = /^APP_KEY=.*$/mu.test(content)
    ? content.replace(/^APP_KEY=.*$/mu, line)
    : `${content.trimEnd()}${content.trim() ? '\n' : ''}${line}\n`

  await writeFile(path, next, 'utf8')
}
