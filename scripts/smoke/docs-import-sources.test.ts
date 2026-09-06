import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import {
  auditDocsImportSources,
  collectEntryPoints,
  extractImports,
  formatReport,
  typescriptFences,
  type DocsImportReport,
} from './docs-import-sources'

const repoRoot = join(import.meta.dir, '..', '..')

let scratch: string

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'guren-docs-imports-'))
})

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

/**
 * One synthetic markdown file, resolved against the real `packages/` tree: the
 * surfaces under test are the actual ones, not a fixture that could drift.
 */
let fixtureCount = 0
async function auditSnippet(...lines: string[]): Promise<DocsImportReport> {
  const dir = join(scratch, `case-${(fixtureCount += 1)}`)
  await rm(dir, { recursive: true, force: true })
  await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
  await writeFile(join(dir, 'snippet.md'), `${['```ts', ...lines, '```'].join('\n')}\n`)
  return auditDocsImportSources(repoRoot, dir)
}

describe('the premises the gate encodes', () => {
  test('@guren/core reaches @guren/server wholesale but @guren/orm by allowlist', async () => {
    // If core ever re-exported ORM wholesale, the interesting half of this check
    // would quietly stop being interesting.
    const barrel = await readFile(join(repoRoot, 'packages', 'core', 'src', 'index.ts'), 'utf8')

    expect(barrel).toContain("export * from '@guren/server'")
    expect(barrel).not.toContain("export * from '@guren/orm'")
  })

  test('every declared @guren/* TypeScript entry point resolves to a source file', async () => {
    // Such a subpath fails the gate on its own, which is intended behaviour but
    // must not be the workspace's state on an ordinary day.
    const entryPoints = [...(await collectEntryPoints(repoRoot)).values()]

    expect(entryPoints.filter((entry) => entry.kind === 'unresolved')).toEqual([])
    // The two known non-modules: a stylesheet and a manifest.
    expect(
      entryPoints
        .filter((entry) => entry.kind === 'asset')
        .map((entry) => entry.specifier)
        .sort(),
    ).toEqual(['@guren/inertia-client/package.json', '@guren/plugin-markdown/styles.css'])
  })
})

describe('extraction', () => {
  test('reads an import out of a fence no parser can read', () => {
    // A class body with no class, the shape 67 of the repo's fences take:
    // @babel/parser fails on it even with errorRecovery, so an AST-only scanner
    // reports zero imports for the whole fence.
    const fragment = ['  async store() {', '    // ...', '  }', "import { Controller } from '@guren/core'"].join('\n')

    expect(extractImports(fragment).map((entry) => entry.specifier)).toEqual(['@guren/core'])
  })

  test('reads a multi-line named import list and a bare side-effect import', () => {
    const code = [
      'import {',
      '  Controller,',
      '  Router,',
      "} from '@guren/core'",
      "import '@guren/plugin-markdown/styles.css'",
    ].join('\n')

    expect(extractImports(code).map((entry) => entry.specifier)).toEqual([
      '@guren/core',
      '@guren/plugin-markdown/styles.css',
    ])
  })

  test('reads a side-effect import that precedes a named one as its own statement', () => {
    // The scaffold's src/app.ts opens with `import 'zod/compile'`; the span
    // before `from` used to run through that quote and swallow the statement.
    const code = [
      "import 'zod/compile'",
      "import { createApp } from '@guren/core'",
    ].join('\n')

    expect(extractImports(code).map((entry) => entry.specifier)).toEqual(['zod/compile', '@guren/core'])
  })

  test('only TypeScript fences are scanned', () => {
    const markdown = ['```bash', "import { X } from '@guren/core'", '```', '', '```ts', 'const a = 1', '```'].join('\n')

    expect(typescriptFences(markdown)).toHaveLength(1)
  })
})

describe('a symbol the specifier does not export', () => {
  test('passes an import of a symbol the entry point really exports', async () => {
    const report = await auditSnippet("import { Controller, Router } from '@guren/core'")

    expect(report.unexported).toEqual([])
    expect(report.unresolvable).toEqual([])
    expect(report.symbolsChecked).toBe(2)
  })

  test('fails a symbol imported from the wrong first-party package, and names the right one', async () => {
    // The line that shipped: AgentApprovalRequested really is re-exported from
    // core, while mcpPlugin only ever came from @guren/plugin-mcp.
    const report = await auditSnippet("import { AgentApprovalRequested, mcpPlugin } from '@guren/core'")

    expect(report.unexported).toHaveLength(1)
    const [finding] = report.unexported
    expect(finding?.symbol).toBe('mcpPlugin')
    expect(finding?.specifier).toBe('@guren/core')
    expect(finding?.exportedBy).toEqual(['@guren/plugin-mcp'])
    expect(formatReport(report)).toContain('exported by @guren/plugin-mcp')
  })

  test('says so plainly when no first-party package exports the symbol at all', async () => {
    const report = await auditSnippet("import { NotARealExport } from '@guren/core'")

    expect(report.unexported).toHaveLength(1)
    expect(report.unexported[0]?.exportedBy).toEqual([])
    expect(formatReport(report)).toContain('no first-party entry point exports it')
  })

  test('reports the file and line of the offending import', async () => {
    const report = await auditSnippet('const a = 1', '', "import { NotARealExport } from '@guren/core'")

    // fence opens on line 1, so its third content line is line 4.
    expect(report.unexported[0]?.location).toMatch(/snippet\.md:4$/u)
  })
})

describe('type-only imports', () => {
  // Decision 3: absent from the merged set means absent from both spaces, a
  // sound verdict; the finer claim needs a type checker this gate does not run.
  test('checks a type-only import exactly like a value import', async () => {
    const report = await auditSnippet("import type { NotARealType } from '@guren/core'")

    expect(report.unexported).toHaveLength(1)
    expect(report.unexported[0]?.symbol).toBe('NotARealType')
  })

  test('accepts a name that core exports only as a type', async () => {
    // PostgresDatabase reaches core through `export type { … } from '@guren/orm'`.
    const report = await auditSnippet("import type { PostgresDatabase } from '@guren/core'")

    expect(report.unexported).toEqual([])
  })

  test('checks both halves of a mixed inline-type import', async () => {
    const report = await auditSnippet("import { type Controller, NotARealExport } from '@guren/core'")

    expect(report.unexported.map((finding) => finding.symbol)).toEqual(['NotARealExport'])
    expect(report.symbolsChecked).toBe(2)
  })
})

describe('specifiers the gate cannot resolve', () => {
  // Decision 4: an unavailable check is not a green one.
  test('fails an unknown first-party package rather than skipping it', async () => {
    const report = await auditSnippet("import { anything } from '@guren/not-a-package'")

    expect(report.unexported).toEqual([])
    expect(report.unresolvable).toHaveLength(1)
    expect(report.unresolvable[0]?.reason).toContain('no such first-party package')
  })

  test('fails a subpath the exports map does not declare', async () => {
    const report = await auditSnippet("import { anything } from '@guren/core/not-a-subpath'")

    expect(report.unresolvable).toHaveLength(1)
    expect(report.unresolvable[0]?.reason).toContain('exports map')
  })

  test('fails a named import from a non-module asset entry point', async () => {
    const report = await auditSnippet("import { theme } from '@guren/plugin-markdown/styles.css'")

    expect(report.unresolvable).toHaveLength(1)
    expect(report.unresolvable[0]?.reason).toContain('static asset')
  })

  // These two forms name no symbols, so a loop that skips ahead when there is
  // nothing to look up skips "does this package exist" with it.
  test('fails a namespace import of a package that does not exist', async () => {
    const report = await auditSnippet("import * as everything from '@guren/not-a-package'")

    expect(report.unresolvable).toHaveLength(1)
    expect(report.unresolvable[0]?.reason).toContain('no such first-party package')
  })

  test('fails a bare side-effect import of a subpath that does not exist', async () => {
    const report = await auditSnippet("import '@guren/core/not-a-subpath'")

    expect(report.unresolvable).toHaveLength(1)
    expect(report.unresolvable[0]?.reason).toContain('exports map')
  })

  test('allows a bare side-effect import of a real asset subpath', async () => {
    // What `docs/{en,ja}/guides/markdown.md` does. A stylesheet having no named
    // exports is not a finding; the subpath existing is all that can be asked.
    const report = await auditSnippet("import '@guren/plugin-markdown/styles.css'")

    expect(report.unresolvable).toEqual([])
    expect(report.unexported).toEqual([])
  })

  test('leaves a third-party specifier alone', async () => {
    const report = await auditSnippet("import { z } from 'zod'", "import React from 'react'")

    expect(report.unresolvable).toEqual([])
    expect(report.importsChecked).toBe(0)
  })
})

describe('entry points whose surface is open', () => {
  test('issues no absence verdict for a wholesale third-party re-export, and names it', async () => {
    // @guren/orm/drizzle/pg is `export * from 'drizzle-orm/pg-core'`, so calling
    // pgTable absent would be unsound; 10 docs snippets import from here.
    const report = await auditSnippet("import { pgTable, sql } from '@guren/orm/drizzle/pg'")

    expect(report.unexported).toEqual([])
    expect(report.openEntryPoints).toContain("@guren/orm/drizzle/pg (re-exports 'drizzle-orm/pg-core')")
  })

  test('the set of open entry points is exactly the subpaths that earn it', async () => {
    // Pinned so it cannot grow unnoticed: each addition is a slice of `docs/`
    // that stops being checked. `docs-audit.ts` fails on an open root outright.
    const report = await auditDocsImportSources(repoRoot, join(repoRoot, 'docs'))
    const open = [...report.openEntryPoints].map((entry) => entry.split(' ')[0]).sort()

    expect(open).toEqual([
      '@guren/core/jsx-dev-runtime',
      '@guren/core/jsx-runtime',
      '@guren/orm/drizzle/mysql',
      '@guren/orm/drizzle/pg',
      '@guren/orm/drizzle/sqlite',
      '@guren/server/jsx-dev-runtime',
      '@guren/server/jsx-runtime',
    ])
    // None of them is a package root, which is the shape that would collapse
    // coverage rather than trim it.
    expect(open.filter((entry) => entry!.split('/').length === 2)).toEqual([])
  })
})

describe('the docs tree as committed', () => {
  test('every named first-party import in docs/ resolves to a real export', async () => {
    const report = await auditDocsImportSources(repoRoot)

    expect(formatReport(report)).toBe('')
    // Guard against the sweep going vacuous: a refactor that stopped finding
    // fences would otherwise report a clean pass over nothing.
    expect(report.symbolsChecked).toBeGreaterThan(500)
  })
})
