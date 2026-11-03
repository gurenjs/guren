import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { TEMPLATES_ROOT, templateManifests } from '../src/blueprints'

const DEPENDENCY_GROUPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

type Manifest = Partial<Record<(typeof DEPENDENCY_GROUPS)[number], Record<string, string>>>

// mermaid depends on katex, whose advisory `guren audit` (A06) reported on every
// fresh scaffold. The docs viewer is its only user and shows a diagram's source
// with a `bun add -d mermaid` hint when the app has none.
describe('template mermaid dependency', () => {
  it('is declared by no template manifest', async () => {
    const checked: string[] = []
    const declared: string[] = []
    for (const path of await templateManifests()) {
      const file = relative(TEMPLATES_ROOT, path).replaceAll('\\', '/')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as Manifest
      checked.push(file)
      for (const group of DEPENDENCY_GROUPS) {
        if (manifest[group]?.mermaid !== undefined) declared.push(`${file} ${group}`)
      }
    }

    expect(checked).toContain('default/package.json')
    expect(declared).toEqual([])
  })
})
