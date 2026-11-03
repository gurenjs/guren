import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import manifest from '../package.json'

// `"sideEffects": false` lets a bundler drop every module a page does not use, which is what keeps
// `react-dom/server` (reached from the root entry through `server.tsx`) out of client bundles.
// It is a claim about every file in src/: a module that registers a listener, assigns a global or
// imports CSS at load would be dropped as well, and needs listing in `sideEffects` instead.
const SRC = join(import.meta.dir, '../src')
const workDir = mkdtempSync(join(tmpdir(), 'inertia-client-side-effects-'))

afterAll(() => rmSync(workDir, { recursive: true, force: true }))

/** What loading `file` runs, with the package's `sideEffects` ignored and dependencies external. */
async function loadTimeCode(file: string): Promise<string> {
  const entry = join(workDir, `${file}.entry.ts`)
  writeFileSync(entry, `import ${JSON.stringify(join(SRC, file))}\n`)
  const result = await Bun.build({
    entrypoints: [entry],
    packages: 'external',
    target: 'browser',
    ignoreDCEAnnotations: true,
    minify: { syntax: true, whitespace: true },
  })
  if (!result.success) throw new AggregateError(result.logs, `bundling ${file} failed`)
  return (await result.outputs[0]!.text())
    .replace(/import\s*[^;"]*?from\s*"[^"]+";?/g, '')
    .replace(/import\s*"[^"]+";?/g, '')
    // A registered symbol is the one top-level call src/ makes, and it touches no state.
    .replace(/var (?:\w+=Symbol\.for\("[^"]*"\),?)+;?/g, '')
    .trim()
}

describe('package sideEffects', () => {
  test('declares every module side-effect-free', () => {
    expect(manifest.sideEffects).toBe(false)
  })

  const files = readdirSync(SRC).filter((name) => /\.tsx?$/.test(name) && !name.endsWith('.d.ts'))

  test.each(files)('%s runs nothing when it is imported', async (file) => {
    expect(await loadTimeCode(file)).toBe('')
  })
})
