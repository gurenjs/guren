import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parseCanFlag } from '../src/commands/navigation'
import { addNavigationEntryFile, appendNavigationEntry, removeNavigationEntry, removeNavigationEntryFile, type NavigationEntryInput } from '../src/navigation-writer'
import { createTempWorkspace, writeWorkspaceFiles, type TempWorkspace } from './helpers'

const HEAD = "import { defineNavigation } from '@guren/core'\n"

const FILES: Record<string, string> = {
  trailing: `${HEAD}\nexport default defineNavigation([\n  { label: 'Home', route: 'home' },\n])\n`,
  'no trailing comma': `${HEAD}\nexport default defineNavigation([\n  { label: 'Home', route: 'home' }\n])\n`,
  inline: `${HEAD}export default defineNavigation([{ label: 'Home', route: 'home' }])\n`,
  empty: `${HEAD}\nexport default defineNavigation([])\n`,
  'a commented': `${HEAD}\nexport default defineNavigation([\n  { label: 'Home', route: 'home' }, // the start\n])\n`,
  'a const list': `${HEAD}\nconst entries = [\n    { label: 'Home', route: 'home' },\n]\n\nexport default defineNavigation(entries)\n`,
}

const PLAIN: NavigationEntryInput = { label: 'Jobs', route: 'jobs.index' }
const GUARDED: NavigationEntryInput = { label: "Post a job's", route: 'jobs.create', auth: 'required', can: { ability: 'create', model: 'Job' } }

describe('the navigation writer', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-nav-writer-')
    await writeWorkspaceFiles(workspace.dir, { 'app/Models/Job.ts': 'export class Job {}\n' })
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  test.each(Object.entries(FILES))('should append to a %s list and remove back to the same bytes', (_, source) => {
    for (const input of [PLAIN, GUARDED]) {
      const written = appendNavigationEntry(source, input, workspace.dir)
      expect(removeNavigationEntry(written, input.route, workspace.dir)).toBe(source)
    }
  })

  test('should write the entry last, in the indentation of the one before it, with its model imported', () => {
    expect(appendNavigationEntry(FILES['a const list']!, GUARDED, workspace.dir)).toBe(
      `${HEAD}import { Job } from '@/app/Models/Job'\n\nconst entries = [\n    { label: 'Home', route: 'home' },\n`
      + `    { label: 'Post a job\\'s', route: 'jobs.create', show: { auth: 'required', can: ['create', Job] } },\n]\n\nexport default defineNavigation(entries)\n`,
    )
  })

  test('should keep a model import another entry still names', () => {
    const both = appendNavigationEntry(
      appendNavigationEntry(FILES.trailing!, GUARDED, workspace.dir),
      { label: 'Edit jobs', route: 'jobs.admin', can: { ability: 'update', model: 'Job' } },
      workspace.dir,
    )
    expect(both.match(/import \{ Job \}/gu)).toHaveLength(1)
    const one = removeNavigationEntry(both, 'jobs.create', workspace.dir)
    expect(one).toContain("import { Job } from '@/app/Models/Job'")
    expect(removeNavigationEntry(one, 'jobs.admin', workspace.dir)).toBe(FILES.trailing!)
  })

  test.each([
    ['a route the file already has', { label: 'Home again', route: 'home' }, 'already has an entry for route "home"'],
    ['a label with a line break', { label: 'Two\nlines', route: 'x' }, 'line break'],
    ['a model that is no class name', { label: 'X', route: 'x', can: { ability: 'create', model: 'job' } }, 'no class name'],
  ] as const)('should refuse %s', (_, input, message) => {
    expect(() => appendNavigationEntry(FILES.trailing!, input, workspace.dir)).toThrow(message)
  })

  test('should refuse a file it cannot read back, and a name the file binds to something else', () => {
    const spread = `${HEAD}export default defineNavigation([...others])\n`
    expect(() => appendNavigationEntry(spread, PLAIN, workspace.dir)).toThrow('cannot be read as data')
    const other = `${HEAD}import { Job } from './elsewhere'\nexport default defineNavigation([])\n`
    expect(() => appendNavigationEntry(other, GUARDED, workspace.dir)).toThrow('already imports a Job from ./elsewhere')
    expect(() => removeNavigationEntry(FILES.trailing!, 'jobs.index', workspace.dir)).toThrow('no entry for route "jobs.index"')
  })

  test('should write the file, refusing a model file that is missing or exports no such class', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/navigation.ts': FILES.trailing!, 'app/Models/Post.ts': 'export const posts = 1\n' })
    const file = join(workspace.dir, 'config/navigation.ts')
    await expect(addNavigationEntryFile(workspace.dir, { label: 'X', route: 'x', can: { ability: 'create', model: 'Report' } })).rejects.toThrow('app/Models/Report.ts does not exist')
    await expect(addNavigationEntryFile(workspace.dir, { label: 'X', route: 'x', can: { ability: 'create', model: 'Post' } })).rejects.toThrow('exports no Post')
    expect(await readFile(file, 'utf8')).toBe(FILES.trailing!)

    await addNavigationEntryFile(workspace.dir, GUARDED)
    expect(await readFile(file, 'utf8')).toContain("can: ['create', Job]")
    await removeNavigationEntryFile(workspace.dir, GUARDED.route)
    expect(await readFile(file, 'utf8')).toBe(FILES.trailing!)
  })

  test('should keep a comment on the line it closes, and an import a type still names', () => {
    expect(appendNavigationEntry(FILES['a commented']!, PLAIN, workspace.dir)).toContain("// the start\n  { label: 'Jobs', route: 'jobs.index' },\n")
    const middle = `${HEAD}export default defineNavigation([\n  { label: 'A', route: 'a' },\n  { label: 'B', route: 'b' }, // keep b\n  { label: 'C', route: 'c' },\n])\n`
    expect(removeNavigationEntry(middle, 'b', workspace.dir)).toBe(`${HEAD}export default defineNavigation([\n  { label: 'A', route: 'a' },\n  { label: 'C', route: 'c' },\n])\n`)
    const typed = `${HEAD}import { Job } from '@/app/Models/Job'\nexport type Posting = Job\nexport default defineNavigation([\n  { label: 'P', route: 'p', show: { can: ['create', Job] } },\n])\n`
    expect(removeNavigationEntry(typed, 'p', workspace.dir)).toContain("import { Job } from '@/app/Models/Job'")
  })

  test('should keep line ends, and a comment an empty list holds', () => {
    const crlf = `${HEAD.replaceAll('\n', '\r\n')}\r\nexport default defineNavigation([\r\n  { label: 'Home', route: 'home' }, // the start\r\n])\r\n`
    const written = appendNavigationEntry(crlf, GUARDED, workspace.dir)
    expect(written.replace(/\r\n/gu, '')).not.toContain('\n')
    expect(written).toContain("// the start\r\n  { label: 'Post a job\\'s'")
    expect(removeNavigationEntry(written, GUARDED.route, workspace.dir)).toBe(crlf)
    const commented = `${HEAD}export default defineNavigation([\n  // Add entries here\n])\n`
    expect(appendNavigationEntry(commented, PLAIN, workspace.dir)).toBe(`${HEAD}export default defineNavigation([\n  // Add entries here\n  { label: 'Jobs', route: 'jobs.index' },\n])\n`)
  })

  test('should write the model import on a line of its own after the last import', () => {
    const commented = `${HEAD.trimEnd()} /* the links,\n   one per route */\nexport default defineNavigation([])\n`
    expect(appendNavigationEntry(commented, GUARDED, workspace.dir)).toStartWith(`${HEAD}import { Job } from '@/app/Models/Job'\n/* the links,`)
    const oneLine = `${HEAD.trimEnd()}; export default defineNavigation([])\n`
    expect(appendNavigationEntry(oneLine, GUARDED, workspace.dir)).toStartWith(`${HEAD.trimEnd()};\nimport { Job } from '@/app/Models/Job'\nexport default`)
  })

  test('should edit around an entry written in parentheses', () => {
    const source = `${HEAD}export default defineNavigation([\n  ({ label: 'Home', route: 'home' }),\n])\n`
    const written = appendNavigationEntry(source, PLAIN, workspace.dir)
    expect(written).toContain("  ({ label: 'Home', route: 'home' }),\n  { label: 'Jobs', route: 'jobs.index' },\n")
    expect(removeNavigationEntry(written, PLAIN.route, workspace.dir)).toBe(source)
    const nested = `${HEAD}export default defineNavigation([\n  { label: 'A', route: 'a' },\n  (({ label: 'Home', route: 'home' })),\n])\n`
    expect(removeNavigationEntry(nested, 'home', workspace.dir)).toBe(`${HEAD}export default defineNavigation([\n  { label: 'A', route: 'a' },\n])\n`)
  })

  test('should remove a namespace import once nothing else names it', () => {
    const entry = "export default defineNavigation([\n  { label: 'P', route: 'p', show: { can: ['create', Models.Job] } },\n])\n"
    expect(removeNavigationEntry(`${HEAD}import * as Models from '@/app/Models'\n${entry}`, 'p', workspace.dir)).toBe(`${HEAD}export default defineNavigation([])\n`)
    expect(removeNavigationEntry(`${HEAD}import * as Models from '@/app/Models'\ntype Post = Models.Post\n${entry}`, 'p', workspace.dir)).toContain('import * as Models')
    expect(removeNavigationEntry(`${HEAD}import D, * as Models from '@/app/Models'\nD\n${entry}`, 'p', workspace.dir)).toContain("import D from '@/app/Models'\n")
  })

  test.each([
    ['a type-only specifier', "import { type Job } from '@/app/Models/Job'\n", 'not as the class\'s named value export'],
    ['an alias', "import { Report as Job } from '@/app/Models/Job'\n", 'not as the class\'s named value export'],
    ['a local type', 'type Job = string\n', 'already names a Job that is not the model'],
  ] as const)('should refuse a model name the file binds through %s', (_, binding, message) => {
    expect(() => appendNavigationEntry(`${HEAD}${binding}export default defineNavigation([])\n`, GUARDED, workspace.dir)).toThrow(message)
  })

  test('should reuse a relative import of the model, and cut a specifier beside a default import', () => {
    const relative = `${HEAD}import { Job } from '../app/Models/Job.js'\nexport default defineNavigation([])\n`
    expect(appendNavigationEntry(relative, GUARDED, workspace.dir).match(/import/gu)).toHaveLength(2)
    const entry = "export default defineNavigation([\n  { label: 'P', route: 'p', show: { can: ['create', Job] } },\n])\n"
    expect(removeNavigationEntry(`${HEAD}import Job, { other } from '@/app/Models/Job'\nother\n${entry}`, 'p', workspace.dir)).toContain("import { other } from '@/app/Models/Job'\n")
    expect(removeNavigationEntry(`${HEAD}import Other, { Job } from '@/app/Models/Job'\nOther\n${entry}`, 'p', workspace.dir)).toContain("import Other from '@/app/Models/Job'\n")
  })

  test('should write nothing when the edit would not read back', () => {
    const source = `${HEAD}export default defineNavigation([\n  { label: 'A', route: 'a' } /* note */,\n  { label: 'B', route: 'b' },\n])\n`
    expect(() => removeNavigationEntry(source, 'a', workspace.dir)).toThrow('would not read back as intended')
  })

  test.each([
    ['a type re-export', "export type { Job } from './x'\n"],
    ['a declared class', 'export declare class Job {}\n'],
    ['a value', 'export const Job = 123\n'],
  ])('should refuse a model file that exports the name as %s', async (_, model) => {
    await writeWorkspaceFiles(workspace.dir, { 'config/navigation.ts': FILES.trailing!, 'app/Models/Job.ts': model })
    await expect(addNavigationEntryFile(workspace.dir, GUARDED)).rejects.toThrow('as no runtime class')
  })

  test.each([
    ['a class exported by name', 'class Job {}\nexport { Job }\n', undefined],
    ['a value it cannot read', 'export const Job = make()\n', 'its value is not a class written in the file'],
    ['a re-export', "export { Job } from './other'\n", 're-exports Job from ./other'],
    ['export *', "export * from './base'\n", 'export *'],
  ])('should confirm or warn on %s', async (_, model, warning) => {
    await writeWorkspaceFiles(workspace.dir, { 'config/navigation.ts': FILES.trailing!, 'app/Models/Job.ts': model })
    const { unverified } = await addNavigationEntryFile(workspace.dir, GUARDED)
    if (warning === undefined) expect(unverified).toBeUndefined()
    else expect(unverified).toContain(warning)
  })

  test('should keep every entry two writers add at once', async () => {
    await writeWorkspaceFiles(workspace.dir, { 'config/navigation.ts': FILES.empty! })
    await Promise.all(['a', 'b', 'c', 'd'].map((route) => addNavigationEntryFile(workspace.dir, { label: route, route })))
    const written = await readFile(join(workspace.dir, 'config/navigation.ts'), 'utf8')
    for (const route of ['a', 'b', 'c', 'd']) expect(written).toContain(`route: '${route}'`)
  })

  test('should refuse an app with no config/navigation.ts', async () => {
    await expect(addNavigationEntryFile(workspace.dir, PLAIN)).rejects.toThrow('config/navigation.ts does not exist')
  })
})

describe('parseCanFlag', () => {
  test('should split the model off after the last colon', () => {
    expect(parseCanFlag('create:Job')).toEqual({ ability: 'create', model: 'Job' })
    expect(parseCanFlag('jobs:create:Job')).toEqual({ ability: 'jobs:create', model: 'Job' })
    expect(() => parseCanFlag('create')).toThrow('<ability>:<Model>')
  })
})
