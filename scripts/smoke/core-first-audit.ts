/**
 * Application code imports the framework from `@guren/core` (RFC 0024, "Import
 * surface for application code"). Two rules over what users read and copy: no
 * `@guren/server` anywhere, and no import of the root `@guren/orm` specifier.
 * `@guren/orm/drizzle/<dialect>` is the schema DSL and stays allowed. Whole files
 * are matched rather than `ts` fences, since a `diff` fence or a blockquoted
 * snippet is copied as readily.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')

const APPLICATION_CODE = [
  'README.md',
  'docs',
  'examples',
  'web',
  'packages/create-app/templates',
]

/**
 * The harness names a deep `@guren/server/src/...` path as what a plugin must not
 * import, so it is held to the ORM rule only.
 */
const AGENT_HARNESS = 'packages/cli/templates'

const ignoredFileNames = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
])

const ignoredDirNames = new Set([
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.turbo',
  '.guren',
  '.vercel',
  'coverage',
])

/**
 * `from '@guren/orm'`, `import '@guren/orm'` and `import('@guren/orm')`. A subpath,
 * a `declare module` augmentation, a manifest key and prose in backticks all miss.
 */
const ORM_ROOT_IMPORT = /(?:\bfrom|\bimport)\s*\(?\s*(['"])@guren\/orm\1/g

export function ormRootImportLines(source: string): number[] {
  const lines: number[] = []
  for (const match of source.matchAll(ORM_ROOT_IMPORT)) {
    lines.push(source.slice(0, match.index).split('\n').length)
  }
  return lines
}

async function collectFiles(entryPath: string): Promise<string[]> {
  if ((await stat(entryPath)).isFile()) {
    return [entryPath]
  }

  const entries = await readdir(entryPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (ignoredDirNames.has(entry.name) || ignoredFileNames.has(entry.name)) {
      continue
    }

    const absolutePath = join(entryPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectFiles(absolutePath))
      continue
    }

    if (entry.isFile()) {
      files.push(absolutePath)
    }
  }

  return files
}

async function main(): Promise<void> {
  const serverReferences: string[] = []
  const ormRootImports: string[] = []

  for (const target of [...APPLICATION_CODE, AGENT_HARNESS]) {
    const files = await collectFiles(resolve(repoRoot, target))

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8')
      const path = relative(repoRoot, filePath)
      if (target !== AGENT_HARNESS && source.includes('@guren/server')) {
        serverReferences.push(path)
      }
      for (const line of ormRootImportLines(source)) {
        ormRootImports.push(`${path}:${line}`)
      }
    }
  }

  if (serverReferences.length > 0) {
    console.error('Core-first audit failed. Found stale @guren/server references in:')
    for (const violation of serverReferences) {
      console.error(`- ${violation}`)
    }
  }
  if (ormRootImports.length > 0) {
    console.error(
      "Core-first audit failed. Import these from '@guren/core' instead of '@guren/orm' " +
        '(only @guren/orm/drizzle/<dialect> is imported directly, for schema definitions):',
    )
    for (const violation of ormRootImports) {
      console.error(`- ${violation}`)
    }
  }
  if (serverReferences.length > 0 || ormRootImports.length > 0) {
    process.exit(1)
  }

  console.log('Core-first audit passed.')
}

if (import.meta.main) {
  await main()
}
