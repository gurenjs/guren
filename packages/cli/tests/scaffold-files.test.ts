import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CliError } from '../src/cli-error'
import { writeScaffoldFile, writeScaffoldFiles, type ScaffoldFileEntry, type ScaffoldFilesOptions } from '../src/utils'
import { captureInfos, snapshotTree, writeWorkspaceFiles } from './helpers'

const ENTRIES: ScaffoldFileEntry[] = [
  { path: 'app/Models/Post.ts', contents: 'export class Post {}\n' },
  { path: 'config/mail.ts', contents: 'export default {}\n' },
  { path: 'routes/posts.ts', contents: 'export {}\n' },
]

// Writes through `cwd`, so no test here needs `createTempWorkspace`'s process-wide chdir.
describe('writeScaffoldFiles over files that already exist', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-cli-scaffold-files-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses the whole batch, naming every file in the way in batch order, and writes none', async () => {
    await writeWorkspaceFiles(dir, { 'routes/posts.ts': '// mine\n', 'app/Models/Post.ts': '// mine\n' })
    const before = await snapshotTree(dir)

    const error = await writeScaffoldFiles(ENTRIES, { cwd: dir }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(CliError)
    expect((error as CliError).message).toBe([
      'Scaffolding would overwrite 2 files that already exist:',
      '  app/Models/Post.ts',
      '  routes/posts.ts',
      'Nothing was scaffolded. Pass --force to overwrite them.',
    ].join('\n'))
    expect(await snapshotTree(dir)).toEqual(before)
  })

  it.each<{ name: string; entries: ScaffoldFileEntry[]; options: ScaffoldFilesOptions; message: string[] }>([
    {
      name: 'offers another name when the command was given one',
      entries: ENTRIES.slice(0, 1),
      options: { subject: 'Post' },
      message: [
        'Scaffolding Post would overwrite a file that already exists:',
        '  app/Models/Post.ts',
        'Nothing was scaffolded. Pick another name, or pass --force to overwrite it.',
      ],
    },
    {
      name: 'offers dropping the flags when every file in the way came from one',
      entries: [{ ...ENTRIES[0]!, flag: '--policy' }, { ...ENTRIES[1]!, flag: '--test' }],
      options: {},
      message: [
        'Scaffolding would overwrite 2 files that already exist:',
        '  app/Models/Post.ts (--policy)',
        '  config/mail.ts (--test)',
        'Nothing was scaffolded. Drop --policy and --test, or pass --force to overwrite them.',
      ],
    },
    {
      name: 'names a flag once however many of its files are in the way',
      entries: [{ ...ENTRIES[0]!, flag: '--test' }, { ...ENTRIES[1]!, flag: '--test' }],
      options: { subject: 'Post' },
      message: [
        'Scaffolding Post would overwrite 2 files that already exist:',
        '  app/Models/Post.ts (--test)',
        '  config/mail.ts (--test)',
        'Nothing was scaffolded. Drop --test, pick another name, or pass --force to overwrite them.',
      ],
    },
    {
      name: 'offers no flag when one file in the way came from none',
      entries: [{ ...ENTRIES[0]!, flag: '--test' }, ENTRIES[1]!],
      options: {},
      message: [
        'Scaffolding would overwrite 2 files that already exist:',
        '  app/Models/Post.ts (--test)',
        '  config/mail.ts',
        'Nothing was scaffolded. Pass --force to overwrite them.',
      ],
    },
  ])('$name', async ({ entries, options, message }) => {
    await writeWorkspaceFiles(dir, Object.fromEntries(entries.map((entry) => [entry.path, '// mine\n'])))

    await expect(writeScaffoldFiles(entries, { ...options, cwd: dir })).rejects.toThrow(message.join('\n'))
  })

  it('refuses a single-file write in the same words', async () => {
    await writeWorkspaceFiles(dir, { 'config/mail.ts': '// mine\n' })

    await expect(writeScaffoldFile('config/mail.ts', 'export default {}\n', { cwd: dir })).rejects.toThrow([
      'Scaffolding would overwrite a file that already exists:',
      '  config/mail.ts',
      'Nothing was scaffolded. Pass --force to overwrite it.',
    ].join('\n'))
    expect(await readFile(join(dir, 'config/mail.ts'), 'utf8')).toBe('// mine\n')
  })

  // `wx` refuses a dangling symlink, so a probe that followed it (`access`) would let the
  // batch start and stop on it.
  it('counts a dangling symlink as a file in the way', async () => {
    await writeWorkspaceFiles(dir, { 'config/.keep': '' })
    await symlink(join(dir, 'nowhere.ts'), join(dir, 'config/mail.ts'))

    await expect(writeScaffoldFiles(ENTRIES, { cwd: dir })).rejects.toThrow('  config/mail.ts\nNothing was scaffolded.')
    // `snapshotTree` reads through the link, so the tree is compared by name.
    expect((await readdir(dir, { recursive: true })).sort()).toEqual(['config', 'config/.keep', 'config/mail.ts'])
  })

  it('throws what the probe cannot answer before writing anything', async () => {
    // `routes` is a file, so probing `routes/posts.ts` fails with ENOTDIR rather than ENOENT.
    await writeWorkspaceFiles(dir, { routes: 'not a directory\n' })
    const before = await snapshotTree(dir)

    const error = await writeScaffoldFiles(ENTRIES, { cwd: dir }).catch((reason: unknown) => reason)

    expect((error as NodeJS.ErrnoException).code).toBe('ENOTDIR')
    expect(await snapshotTree(dir)).toEqual(before)
  })

  it('overwrites every file in the way under --force and reports them as overwritten', async () => {
    await writeWorkspaceFiles(dir, { 'config/mail.ts': '// mine\n' })
    const overwritten: string[] = []

    const created = await writeScaffoldFiles(ENTRIES, { cwd: dir, force: true, overwritten })

    expect(created.map((file) => relative(dir, file))).toEqual(ENTRIES.map((entry) => entry.path))
    expect(overwritten.map((file) => relative(dir, file))).toEqual(['config/mail.ts'])
    expect(await readFile(join(dir, 'config/mail.ts'), 'utf8')).toBe('export default {}\n')
  })

  it('skips the files in the way under skipExisting and writes the rest', async () => {
    await writeWorkspaceFiles(dir, { 'config/mail.ts': '// mine\n' })
    let created: string[] = []

    const infos = await captureInfos(async () => {
      created = await writeScaffoldFiles(ENTRIES, { cwd: dir, skipExisting: true })
    })

    expect(created.map((file) => relative(dir, file))).toEqual(['app/Models/Post.ts', 'routes/posts.ts'])
    expect(infos).toEqual(['config/mail.ts already exists — left unchanged (use --force to overwrite).'])
    expect(await readFile(join(dir, 'config/mail.ts'), 'utf8')).toBe('// mine\n')
  })
})
