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
    const crlf = `${HEAD.replace('\n', '\r\n')}\r\nexport default defineNavigation([\r\n  { label: 'Home', route: 'home' }, // the start\r\n])\r\n`
    const written = appendNavigationEntry(crlf, GUARDED, workspace.dir)
    expect(written.replace(/\r\n/gu, '')).not.toContain('\n')
    expect(written).toContain("// the start\r\n  { label: 'Post a job\\'s'")
    expect(removeNavigationEntry(written, GUARDED.route, workspace.dir)).toBe(crlf)
    const commented = `${HEAD}export default defineNavigation([\n  // Add entries here\n])\n`
    expect(appendNavigationEntry(commented, PLAIN, workspace.dir)).toBe(`${HEAD}export default defineNavigation([\n  // Add entries here\n  { label: 'Jobs', route: 'jobs.index' },\n])\n`)
  })

  test('should write the model import on a line of its own after the last import', () => {
    const source = `${HEAD.trimEnd()} /* the links,\n   one per route */\nexport default defineNavigation([])\n`
    expect(appendNavigationEntry(source, GUARDED, workspace.dir)).toStartWith(`${HEAD}import { Job } from '@/app/Models/Job' /* the links,`)
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
