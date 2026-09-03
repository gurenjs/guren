import { describe, test, expect, afterEach } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeWorkspaceFiles } from './helpers'
import { generateAttachmentTypes } from '../src/attachments-types'

const cleanups: Array<() => Promise<void>> = []

async function makeApp(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'guren-attachments-types-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  await writeWorkspaceFiles(dir, files)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const POST_MODEL = `import { Attachable, hasOneAttached, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached({
    image: 'require',
    variants: { thumb: { width: 320 }, og: { width: 1200, height: 630 } },
  }),
  images: hasManyAttached({ image: 'require' }),
}) {}
`

const PLAIN_MODEL = `import { defineModel } from '@guren/orm'
import { users } from '../../db/schema.js'

export class User extends defineModel(users) {}
`

describe('generateAttachmentTypes', () => {
  test('emits kinds and variant unions for Attachable models, module models included', async () => {
    const dir = await makeApp({
      'app/Models/Post.ts': POST_MODEL,
      'app/Models/User.ts': PLAIN_MODEL,
      'modules/media/app/Models/Clip.ts': `import { Attachable, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { clips } from '../../db/schema.js'

export class Clip extends Attachable(defineModel(clips), {
  stills: hasManyAttached(),
}) {}
`,
    })

    const { outputPath, models, warnings } = await generateAttachmentTypes({ appRoot: dir })

    expect(warnings).toEqual([])
    expect(models).toEqual(['Clip', 'Post'])
    expect(outputPath).toBe(join(dir, '.guren/attachments.gen.ts'))

    const content = await readFile(outputPath!, 'utf-8')
    expect(content).toContain("Post: { cover: 'one'; images: 'many' }")
    expect(content).toContain("Clip: { stills: 'many' }")
    expect(content).toContain("Post: { cover: 'og' | 'thumb'; images: never }")
    expect(content).toContain('Clip: { stills: never }')
    expect(content).toContain('export type AttachmentName<M extends keyof AttachmentsMap> = keyof AttachmentsMap[M]')
    // An empty entry would type `AttachmentsMap['User']` as a real, attachment-less contract.
    expect(content).not.toContain('User')
  })

  test('emits nothing and removes a stale file for apps without Attachable models', async () => {
    const dir = await makeApp({
      'app/Models/User.ts': PLAIN_MODEL,
      '.guren/attachments.gen.ts': '// stale\nexport interface AttachmentsMap { Post: { cover: \'one\' } }\n',
    })

    const { outputPath, models } = await generateAttachmentTypes({ appRoot: dir })

    expect(outputPath).toBeNull()
    expect(models).toEqual([])
    expect(existsSync(join(dir, '.guren/attachments.gen.ts'))).toBe(false)
  })

  test('skips an unreadable declaration with a warning instead of emitting it partially', async () => {
    const dir = await makeApp({
      'app/Models/Post.ts': POST_MODEL,
      'app/Models/Doc.ts': `import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { docs } from '../../db/schema.js'
import { shared } from './shared.js'

export class Doc extends Attachable(defineModel(docs), {
  file: hasOneAttached(),
  ...shared,
}) {}
`,
    })

    const { models, warnings, outputPath } = await generateAttachmentTypes({ appRoot: dir })

    expect(models).toEqual(['Post'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('app/Models/Doc.ts')
    expect(warnings[0]).toContain('Doc')

    const content = await readFile(outputPath!, 'utf-8')
    expect(content).not.toContain('Doc')
  })

  test('emits an entry for an empty Attachable declaration', async () => {
    // Attachable(Base, {}) is still an Attachable model at runtime, so it belongs in the map.
    const dir = await makeApp({
      'app/Models/Note.ts': `import { Attachable } from '@guren/core'
import { defineModel } from '@guren/orm'
import { notes } from '../../db/schema.js'

export class Note extends Attachable(defineModel(notes), {}) {}
`,
    })

    const { outputPath, models, warnings } = await generateAttachmentTypes({ appRoot: dir })

    expect(warnings).toEqual([])
    expect(models).toEqual(['Note'])
    const content = await readFile(outputPath!, 'utf-8')
    expect(content).toContain('Note: {}')
  })

  test('keeps an existing file when models were skipped with warnings', async () => {
    // Removal is on positive evidence only: an unparsable model may hide an Attachable
    // declaration, and deleting the module from under its importers is worse than a stale map.
    const stale = "export interface AttachmentsMap { Post: { cover: 'one' } }\n"
    const dir = await makeApp({
      '.guren/attachments.gen.ts': stale,
      'app/Models/Post.ts': 'import { Attachable } from "@guren/core"\nexport class {{{ Attachable',
    })

    const { outputPath, models, warnings } = await generateAttachmentTypes({ appRoot: dir })

    expect(outputPath).toBeNull()
    expect(models).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('could not be read as a model')
    expect(await readFile(join(dir, '.guren/attachments.gen.ts'), 'utf-8')).toBe(stale)
  })

  test('skips a class name declared attachable in more than one location', async () => {
    const files = {
      'app/Models/Post.ts': POST_MODEL,
      'modules/blog/app/Models/Post.ts': `import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  banner: hasOneAttached(),
}) {}
`,
    }
    const dir = await makeApp(files)

    const { outputPath, models, warnings } = await generateAttachmentTypes({ appRoot: dir })

    // The runtime keys both classes as 'Post', so neither entry would be truthful.
    expect(models).toEqual([])
    expect(outputPath).toBeNull()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('multiple locations')
  })
})
