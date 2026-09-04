import { describe, expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packagesDir = fileURLToPath(new URL('../..', import.meta.url))

async function collectTemplateFiles(): Promise<string[]> {
  const packages = await readdir(packagesDir, { withFileTypes: true })
  const files: string[] = []

  for (const pkg of packages) {
    if (!pkg.isDirectory()) {
      continue
    }

    const templates = join(packagesDir, pkg.name, 'templates')
    let entries: string[]
    try {
      entries = await readdir(templates, { recursive: true })
    } catch {
      continue
    }

    // Recursive readdir yields platform separators; normalize them. A template
    // directory can hold a package.json, so a stray `bun install` in one would
    // otherwise drag dependency ignore files in.
    files.push(...entries
      .map((entry) => `${pkg.name}/templates/${entry.replaceAll('\\', '/')}`)
      .filter((entry) => !entry.split('/').includes('node_modules')))
  }

  return files
}

describe('scaffolding templates', () => {
  // npm silently drops every file literally named `.gitignore` from a published
  // tarball, so the convention is `_gitignore`. scripts/smoke/fresh-app.ts
  // checks the packed tarball; this is the fast gate on every `test:bun`.
  it('carry no file literally named .gitignore', async () => {
    const files = await collectTemplateFiles()

    expect(files.filter((file) => file.endsWith('.gitignore'))).toEqual([])
  })

  // A blueprint that ships no ignore rules at all is the same bug wearing a
  // different hat, so name the templates rather than asserting "at least one".
  it('give every create-guren-app base template an ignore file', async () => {
    const files = await collectTemplateFiles()

    for (const template of ['default', 'api-only']) {
      expect(files).toContain(`create-app/templates/${template}/_gitignore`)
    }
  })
})
