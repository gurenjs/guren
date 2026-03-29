import { readdir, readFile } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'

const repoRoot = resolve(import.meta.dir, '../..')
const targets = [
  'README.md',
  'docs',
  'examples',
  'web',
  'packages/create-app/templates/default',
]

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
  'coverage',
])

async function collectFiles(entryPath: string): Promise<string[]> {
  const stat = await Bun.file(entryPath)
  if (await stat.exists() && !entryPath.endsWith('/')) {
    const fsStat = await import('node:fs/promises').then((fs) => fs.stat(entryPath))
    if (fsStat.isFile()) {
      return [entryPath]
    }
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
  const violations: string[] = []

  for (const target of targets) {
    const absoluteTarget = resolve(repoRoot, target)
    const files = await collectFiles(absoluteTarget)

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8')
      if (source.includes('@guren/server')) {
        violations.push(relative(repoRoot, filePath))
      }
    }
  }

  if (violations.length > 0) {
    console.error('Core-first audit failed. Found stale @guren/server references in:')
    for (const violation of violations) {
      console.error(`- ${violation}`)
    }
    process.exit(1)
  }

  console.log('Core-first audit passed.')
}

await main()
