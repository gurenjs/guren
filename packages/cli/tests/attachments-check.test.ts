import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { AttachmentDeliveryController, type RouteDefinition } from '@guren/core'
import { checkAttachmentsDelivery, checkAttachmentsPublicDisk } from '../src/attachments-check'
import { runCheck } from '../src/check'
import { ParseCache } from '../src/parse-cache'
import { createTempWorkspace } from './helpers'

describe('runCheck — configureAttachments table binding', () => {
  const SCHEMA_WITH_ATTACHMENTS = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  path: text('path').notNull(),
})`

  const SCHEMA_WITHOUT_ATTACHMENTS = `import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey(),
})`

  function configSource(tableName = 'attachments'): string {
    return `import { configureAttachments } from '@guren/core'
import { ${tableName} } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: ${tableName},
  storage: () => ({}) as never,
  disk: 'media',
})`
  }

  async function writeApp(dir: string, options: { schema: string; config?: string }): Promise<void> {
    await mkdir(join(dir, 'db'), { recursive: true })
    await writeFile(join(dir, 'db/schema.ts'), options.schema, 'utf8')
    if (options.config) {
      await mkdir(join(dir, 'config'), { recursive: true })
      await writeFile(join(dir, 'config/attachments.ts'), options.config, 'utf8')
    }
  }

  it('passes when the bound table is declared in db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-pass-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS, config: configSource() })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when the bound table is missing from db/schema.ts', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-fail-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS, config: configSource() })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain("'attachments'")
      expect(result!.suggestion).toContain('db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('judges an aliased import by its exported name', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-alias-')
    try {
      const config = `import { configureAttachments } from '@guren/core'
import { attachments as att } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: att,
  storage: () => ({}) as never,
  disk: 'media',
})`
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS, config })

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('stays silent when the table cannot be traced to a schema import', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-opaque-')
    try {
      // Imported from somewhere other than db/schema: existence cannot be
      // judged, and a symbol the check cannot trace is not a missing one.
      const config = `import { configureAttachments } from '@guren/core'
import { attachments } from './tables.js'

export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => ({}) as never,
  disk: 'media',
})`
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS, config })

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-config:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('contributes nothing to apps without configureAttachments', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-absent-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS })

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-config:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails a module config whose own schema lacks the table, even when the root declares it', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-module-miss-')
    try {
      // Root declares `attachments`, but the module config imports the
      // module's schema — which does not. Existence is per schema module.
      await writeApp(workspace.dir, { schema: SCHEMA_WITH_ATTACHMENTS })
      await mkdir(join(workspace.dir, 'modules/media/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/db/schema.ts'), SCHEMA_WITHOUT_ATTACHMENTS, 'utf8')
      await mkdir(join(workspace.dir, 'modules/media/config'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/config/attachments.ts'), configSource(), 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.suggestion).toContain('modules/media/db/schema.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees a table exported by a module schema', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachments-module-')
    try {
      await writeApp(workspace.dir, { schema: SCHEMA_WITHOUT_ATTACHMENTS })
      await mkdir(join(workspace.dir, 'modules/media/db'), { recursive: true })
      await writeFile(join(workspace.dir, 'modules/media/db/schema.ts'), SCHEMA_WITH_ATTACHMENTS, 'utf8')
      await mkdir(join(workspace.dir, 'modules/media/config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'modules/media/config/attachments.ts'),
        configSource(),
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-config:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('runCheck — Attachable models without configureAttachments', () => {
  const ATTACHABLE_MODEL = `import { Attachable, hasOneAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends Attachable(defineModel(posts), {
  cover: hasOneAttached(),
}) {}
`

  const CONFIG = `import { configureAttachments } from '@guren/core'
import { posts } from '../db/schema.js'

export const { Attachment } = configureAttachments({
  table: posts,
  storage: () => ({}) as never,
  disk: 'media',
})`

  async function writeModel(dir: string, relPath = 'app/Models/Post.ts', source = ATTACHABLE_MODEL): Promise<void> {
    await mkdir(join(dir, relPath, '..'), { recursive: true })
    await writeFile(join(dir, relPath), source, 'utf8')
  }

  it('fails an Attachable model when no configureAttachments() call exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-missing-')
    try {
      await writeModel(workspace.dir)

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain('Post')
      expect(result!.suggestion).toContain('guren add attachments')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes an Attachable model when a configureAttachments() call exists', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-configured-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(join(workspace.dir, 'config/attachments.ts'), CONFIG, 'utf8')

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees a configureAttachments call made through a namespace import', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-namespace-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/attachments.ts'),
        `import * as core from '@guren/core'
import { posts } from '../db/schema.js'

export const { Attachment } = core.configureAttachments({
  table: posts,
  storage: () => ({}) as never,
  disk: 'media',
})`,
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not treat a mention of configureAttachments in a comment as a config', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-comment-')
    try {
      await writeModel(workspace.dir)
      await mkdir(join(workspace.dir, 'config'), { recursive: true })
      await writeFile(
        join(workspace.dir, 'config/notes.ts'),
        '// TODO: call configureAttachments() here\nexport const notes = true\n',
        'utf8',
      )

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('contributes nothing to apps without Attachable models', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-none-')
    try {
      await writeModel(
        workspace.dir,
        'app/Models/Post.ts',
        `import { defineModel } from '@guren/orm'
import { posts } from '../../db/schema.js'

export class Post extends defineModel(posts) {}
`,
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(report.checks.find((c) => c.key.startsWith('attachments-model:'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees an Attachable model inside a module', async () => {
    const workspace = await createTempWorkspace('guren-cli-check-attachable-module-')
    try {
      await writeModel(workspace.dir, 'modules/media/app/Models/Clip.ts', `import { Attachable, hasManyAttached } from '@guren/core'
import { defineModel } from '@guren/orm'
import { clips } from '../../db/schema.js'

export class Clip extends Attachable(defineModel(clips), {
  stills: hasManyAttached(),
}) {}
`)

      const report = await runCheck({ cwd: workspace.dir })

      const result = report.checks.find((c) => c.key.startsWith('attachments-model:'))
      expect(result).toBeDefined()
      expect(result!.status).toBe('fail')
      expect(result!.message).toContain('Clip')
    } finally {
      await workspace.cleanup()
    }
  })
})

describe('checkAttachmentsDelivery — delivery route wiring (RFC 0015)', () => {
  const MOUNTED = [
    { controller: { name: AttachmentDeliveryController.name } },
  ] as unknown as RouteDefinition[]

  function deliveryConfig(extra = ''): string {
    return `import { configureAttachments } from '@guren/core'

export const { Attachment } = configureAttachments({
  table: {} as never,
  storage: () => ({}) as never,
  disk: 'media',
  delivery: {},${extra}
})`
  }

  async function writeConfig(dir: string, source: string, name = 'config/attachments.ts'): Promise<string> {
    const filePath = join(dir, name)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, 'utf8')
    return filePath
  }

  function runDelivery(
    dir: string,
    files: string[],
    definitions?: RouteDefinition[],
  ): Promise<Awaited<ReturnType<typeof checkAttachmentsDelivery>>> {
    return checkAttachmentsDelivery({ cwd: dir, cache: new ParseCache(), files, definitions })
  }

  it('passes when delivery is configured and the route is registered', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-pass-')
    try {
      const file = await writeConfig(workspace.dir, deliveryConfig())
      const results = await runDelivery(workspace.dir, [file], MOUNTED)

      expect(results.find((c) => c.key === 'attachments-delivery')?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when delivery is configured but no delivery route is registered', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-fail-')
    try {
      const file = await writeConfig(workspace.dir, deliveryConfig())
      const results = await runDelivery(workspace.dir, [file], [])

      const result = results.find((c) => c.key.startsWith('attachments-delivery:'))
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('registerAttachmentRoutes')
      expect(result?.suggestion).toContain('routes/web.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it('fails when delivery is configured and the routes entry file does not exist', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-noroutes-')
    try {
      const file = await writeConfig(workspace.dir, deliveryConfig())
      // No definitions seam and no routes/web.ts: positive evidence that
      // nothing can have mounted the route.
      const results = await runDelivery(workspace.dir, [file])

      const result = results.find((c) => c.key.startsWith('attachments-delivery:'))
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('does not exist')
    } finally {
      await workspace.cleanup()
    }
  })

  it('sees the namespace-import configuration style', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-ns-')
    try {
      const file = await writeConfig(
        workspace.dir,
        `import * as core from '@guren/core'
export const { Attachment } = core.configureAttachments({ table: {} as never, storage: () => ({}) as never, disk: 'media', delivery: {} })`,
      )
      const results = await runDelivery(workspace.dir, [file], [])

      expect(results.find((c) => c.key.startsWith('attachments-delivery:'))?.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it('emits nothing without a delivery option, including delivery: undefined', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-off-')
    try {
      const plain = await writeConfig(
        workspace.dir,
        `import { configureAttachments } from '@guren/core'
export const { Attachment } = configureAttachments({ table: {} as never, storage: () => ({}) as never, disk: 'media' })`,
      )
      const off = await writeConfig(
        workspace.dir,
        `import { configureAttachments } from '@guren/core'
export const { Attachment } = configureAttachments({ table: {} as never, storage: () => ({}) as never, disk: 'media', delivery: undefined })`,
        'config/attachments-off.ts',
      )

      expect(await runDelivery(workspace.dir, [plain, off], [])).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  it('warns when the delivery route name is claimed by more than one route', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-name-')
    try {
      const file = await writeConfig(workspace.dir, deliveryConfig())
      const definitions = [
        { name: 'attachments.show', controller: { name: AttachmentDeliveryController.name } },
        { name: 'attachments.show', controller: { name: 'PostController' } },
      ] as unknown as RouteDefinition[]
      const results = await runDelivery(workspace.dir, [file], definitions)

      const result = results.find((c) => c.key === 'attachments-route-name:attachments.show')
      expect(result?.status).toBe('warn')
      expect(result?.message).toContain('silently')
    } finally {
      await workspace.cleanup()
    }
  })

  // The scaffolder mounts the delivery route in routes/api.ts on an API-only
  // app. A rule that judges against routes/web.ts finds no entry file, treats
  // that as positive evidence nothing could have mounted the route, and fails
  // the app that just mounted it.
  //
  // Deliberately runs with no injected definitions: passing them short-circuits
  // the routes-file lookup entirely, so a test that injects them cannot see
  // this bug at all (it passed against the unfixed code).
  it('does not report an API-only app as having no routes entry', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-api-only-')
    try {
      const file = await writeConfig(workspace.dir, deliveryConfig())
      await writeConfig(workspace.dir, "export function registerApiRoutes(): void {}\n", 'routes/api.ts')

      const results = await runDelivery(workspace.dir, [file])

      // This fixture mounts nothing, so a failure is correct — what matters is
      // which file it was judged against. Blaming routes/web.ts names a file
      // an API-only app was never going to have.
      const failed = results.find((c) => c.key.startsWith('attachments-delivery:'))
      expect(failed?.message).toContain('no route registered by registerAttachmentRoutes()')
      expect(failed?.message).not.toContain('routes/web.ts')
      expect(failed?.suggestion).toContain('routes/api.ts')
    } finally {
      await workspace.cleanup()
    }
  })

  it("fails serve: 'redirect' on a disk whose storage driver cannot presign", async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-redirect-')
    try {
      const config = await writeConfig(
        workspace.dir,
        deliveryConfig(`\n  disks: { vault: { visibility: 'private', serve: 'redirect' } },`),
      )
      const storage = await writeConfig(
        workspace.dir,
        `export const storageConfig = { default: 'vault', disks: { vault: { driver: 'local', root: './storage' } } }`,
        'config/storage.ts',
      )

      const results = await runDelivery(workspace.dir, [config, storage], MOUNTED)

      const result = results.find((c) => c.key.startsWith('attachments-serve-redirect:'))
      expect(result?.status).toBe('fail')
      expect(result?.message).toContain("'local'")
      expect(result?.suggestion).toContain("serve: 'proxy'")
    } finally {
      await workspace.cleanup()
    }
  })

  it('resolves the scaffold shape: a hoisted const disks map passed as shorthand', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-hoisted-')
    try {
      const config = await writeConfig(
        workspace.dir,
        deliveryConfig(`\n  disks: { vault: { visibility: 'private', serve: 'redirect' } },`),
      )
      const provider = await writeConfig(
        workspace.dir,
        `const disks = { vault: { driver: 'local', root: './storage' } }
export function register(): unknown {
  return { disks }
}`,
        'app/Providers/StorageProvider.ts',
      )

      const results = await runDelivery(workspace.dir, [config, provider], MOUNTED)

      expect(results.find((c) => c.key.startsWith('attachments-serve-redirect:'))?.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  it("passes serve: 'redirect' on s3, skips unknown drivers and conflicting evidence", async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-redirect-ok-')
    try {
      const config = await writeConfig(
        workspace.dir,
        deliveryConfig(
          `\n  disks: {\n    media: { visibility: 'private', serve: 'redirect' },\n    mystery: { visibility: 'private', serve: 'redirect' },\n    torn: { visibility: 'private', serve: 'redirect' },\n  },`,
        ),
      )
      const storage = await writeConfig(
        workspace.dir,
        `export const storageConfig = { disks: { media: { driver: 's3', bucket: 'b' }, torn: { driver: 'local' } } }
export const other = { disks: { torn: { driver: 's3' } } }`,
        'config/storage.ts',
      )

      const results = await runDelivery(workspace.dir, [config, storage], MOUNTED)

      expect(results.find((c) => c.key.endsWith(':media'))?.status).toBe('pass')
      // No statically readable driver ('mystery') and conflicting evidence
      // ('torn') are both skipped, never guessed.
      expect(results.find((c) => c.key.endsWith(':mystery'))).toBeUndefined()
      expect(results.find((c) => c.key.endsWith(':torn'))).toBeUndefined()
    } finally {
      await workspace.cleanup()
    }
  })

  it('reaches the redirect rule through runCheck discovery (config/storage.ts is swept)', async () => {
    const workspace = await createTempWorkspace('guren-cli-delivery-runcheck-')
    try {
      await writeConfig(
        workspace.dir,
        `import { configureAttachments } from '@guren/core'
export const { Attachment } = configureAttachments({
  table: {} as never,
  storage: () => ({}) as never,
  disk: 'vault',
  disks: { vault: { visibility: 'private', serve: 'redirect' } },
  delivery: {},
})`,
      )
      await writeConfig(
        workspace.dir,
        `export const storageConfig = { disks: { vault: { driver: 'local', root: './storage' } } }`,
        'config/storage.ts',
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(
        report.checks.find((c) => c.key.startsWith('attachments-serve-redirect:'))?.status,
      ).toBe('fail')
      // No routes entry exists, which is itself the wiring failure.
      expect(
        report.checks.find((c) => c.key.startsWith('attachments-delivery:'))?.status,
      ).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })
})
describe('checkAttachmentsPublicDisk — uploads inside the served tree', () => {
  async function write(dir: string, name: string, source: string): Promise<string> {
    const filePath = join(dir, name)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, 'utf8')
    return filePath
  }

  function attachmentsConfig(disk: string): string {
    return `import { configureAttachments } from '@guren/core'

export const { Attachment } = configureAttachments({
  table: {} as never,
  storage: () => ({}) as never,
  disk: '${disk}',
})`
  }

  function storageProvider(entries: string): string {
    return `const disks = { ${entries} }
export function register(): unknown {
  return { disks }
}`
  }

  function run(dir: string, files: string[]): Promise<Awaited<ReturnType<typeof checkAttachmentsPublicDisk>>> {
    return checkAttachmentsPublicDisk({ cwd: dir, cache: new ParseCache(), files })
  }

  // The shape every app scaffolded before the default changed is still in.
  it('fails a local disk rooted inside public/', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-fail-')
    try {
      const config = await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('public'))
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("public: { driver: 'local', root: './public/storage', url: '/storage' }"),
      )

      const results = await run(workspace.dir, [config, provider])
      const result = results.find((c) => c.key.startsWith('attachments-public-disk:'))

      expect(result?.status).toBe('fail')
      expect(result?.message).toContain('./public/storage')
      expect(result?.suggestion).toContain('registerAttachmentRoutes(router)')
    } finally {
      await workspace.cleanup()
    }
  })

  it('passes a local disk rooted outside public/', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-pass-')
    try {
      const config = await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('local'))
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("local: { driver: 'local', root: './storage/app' }"),
      )

      const results = await run(workspace.dir, [config, provider])

      expect(results.find((c) => c.key.startsWith('attachments-public-disk:'))?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  // `./public` itself, not only a subdirectory of it — the containment test
  // has to accept the boundary, and must not accept a sibling whose name
  // merely extends it.
  it('fails a root that is the public directory itself, and passes public-facing siblings', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-edge-')
    try {
      const config = await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('root'))
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("root: { driver: 'local', root: './public' }"),
      )

      expect((await run(workspace.dir, [config, provider]))[0]?.status).toBe('fail')

      const sibling = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("root: { driver: 'local', root: './public-uploads' }"),
      )
      expect((await run(workspace.dir, [config, sibling]))[0]?.status).toBe('pass')
    } finally {
      await workspace.cleanup()
    }
  })

  // The rule fails a build, so a false positive costs more than a miss:
  // anything it cannot read positively is skipped rather than guessed at.
  it('stays silent on a non-local driver, an unreadable root, and conflicting evidence', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-skip-')
    try {
      const config = await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('media'))

      // s3: not on the local filesystem at all, whatever `root` says.
      const s3 = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("media: { driver: 's3', root: './public/media' }"),
      )
      expect(await run(workspace.dir, [config, s3])).toEqual([])

      // A computed root is not a string literal this scan can judge.
      const computed = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider('media: { driver: \'local\', root: process.env.MEDIA_ROOT }'),
      )
      expect(await run(workspace.dir, [config, computed])).toEqual([])

      // Two declarations disagreeing about the root: unreadable, not
      // first-match-wins.
      const conflicting = await write(
        workspace.dir,
        'config/storage.ts',
        `export const storageConfig = { disks: { media: { driver: 'local', root: './storage/media' } } }`,
      )
      const inPublic = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("media: { driver: 'local', root: './public/media' }"),
      )
      expect(await run(workspace.dir, [config, conflicting, inPublic])).toEqual([])
    } finally {
      await workspace.cleanup()
    }
  })

  // The scaffolded StorageProvider ends its map with `as const`, so the disk
  // scan reads a TSAsExpression rather than an object literal. Getting this
  // wrong is silent: "cannot read the config" and "nothing to flag" are the
  // same empty result, and the app it blinds is the scaffold's own shape.
  it('reads a disks map written `as const`', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-asconst-')
    try {
      const config = await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('public'))
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        `const disks = {
  public: { driver: 'local', root: './public/storage', url: '/storage' },
} as const
export function register(): unknown {
  return { disks }
}`,
      )

      expect((await run(workspace.dir, [config, provider]))[0]?.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  // `satisfies` on the options object used to make every attachments rule —
  // this one included — return nothing at all, because the shared entry scan
  // tested the argument for ObjectExpression without unwrapping first. A
  // security rule that a type annotation silently switches off is worse than
  // no rule, and the failure is invisible: it looks exactly like a clean app.
  it('reads options written with `satisfies` or `as const`', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-wrapped-')
    try {
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("public: { driver: 'local', root: './public/storage', url: '/storage' }"),
      )

      for (const suffix of [' satisfies Record<string, unknown>', ' as const']) {
        const config = await write(
          workspace.dir,
          'config/attachments.ts',
          attachmentsConfig('public').replace(/\}\)$/, `}${suffix})`),
        )
        const results = await run(workspace.dir, [config, provider])
        expect(results[0]?.status).toBe('fail')
      }
    } finally {
      await workspace.cleanup()
    }
  })

  // `as const` on the *string* is a level below the object-level unwrapping:
  // literalString() reads the assertion node, finds no StringLiteral, and
  // answers null — which the rule cannot tell from "no disk declared", so a
  // build-failing security rule is switched off by a type annotation.
  it('reads disk and root names written with `as const`', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-strconst-')
    try {
      const config = await write(
        workspace.dir,
        'config/attachments.ts',
        attachmentsConfig('public').replace("disk: 'public'", "disk: 'public' as const"),
      )
      const provider = await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("public: { driver: 'local' as const, root: './public/storage' as const }"),
      )

      expect((await run(workspace.dir, [config, provider]))[0]?.status).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })

  // `guren storage:link` symlinks public/storage -> storage/app/public, and
  // the storage guide documents `local` rooted at exactly that path. A
  // lexical containment test calls this safe, because storage/app/public is
  // nowhere near public/ as a string.
  describe('symlinked into the served tree', () => {
    async function app(dir: string, root: string): Promise<string[]> {
      const config = await write(dir, 'config/attachments.ts', attachmentsConfig('local'))
      const provider = await write(
        dir,
        'app/Providers/StorageProvider.ts',
        storageProvider(`local: { driver: 'local', root: '${root}' }`),
      )
      await mkdir(join(dir, 'storage/app/public'), { recursive: true })
      await mkdir(join(dir, 'public'), { recursive: true })
      return [config, provider]
    }

    it('fails the documented root once storage:link exposes it', async () => {
      const workspace = await createTempWorkspace('guren-cli-public-disk-link-')
      try {
        const files = await app(workspace.dir, './storage/app/public')
        // Before the link the bytes are genuinely unreachable.
        expect((await run(workspace.dir, files))[0]?.status).toBe('pass')

        await symlink(join(workspace.dir, 'storage/app/public'), join(workspace.dir, 'public/storage'))

        expect((await run(workspace.dir, files))[0]?.status).toBe('fail')
      } finally {
        await workspace.cleanup()
      }
    })

    // The link exposes storage/app/public, which sits *inside* the scaffold's
    // root but does not contain storage/app/attachments. Asking merely whether
    // the two overlap would fail the default scaffold the moment anyone ran
    // storage:link — a false positive on the shape this rule recommends.
    it("passes the scaffold's own root, which the link does not expose", async () => {
      const workspace = await createTempWorkspace('guren-cli-public-disk-link-ok-')
      try {
        const files = await app(workspace.dir, './storage/app')
        await symlink(join(workspace.dir, 'storage/app/public'), join(workspace.dir, 'public/storage'))

        expect((await run(workspace.dir, files))[0]?.status).toBe('pass')
      } finally {
        await workspace.cleanup()
      }
    })

    // The link is created before its target — routine, since the directory
    // appears on first upload. `realpath` cannot resolve it, and resolving
    // only the side that exists puts the two paths in different vocabularies
    // (/var vs /private/var on macOS), so they never compare equal and the
    // scan reports safe. The first upload then creates the target and serves
    // every attachment.
    it('fails a link whose target does not exist yet', async () => {
      const workspace = await createTempWorkspace('guren-cli-public-disk-dangling-')
      try {
        const files = await app(workspace.dir, './storage/app')
        await symlink(join(workspace.dir, 'storage/app/attachments'), join(workspace.dir, 'public/uploads'))

        expect((await run(workspace.dir, files))[0]?.status).toBe('fail')
      } finally {
        await workspace.cleanup()
      }
    })

    // A link into the uploads rather than around them still exposes the files
    // it points at, so containment is tested in both directions against the
    // attachments/ prefix.
    it('fails a link exposing one attachment directory', async () => {
      const workspace = await createTempWorkspace('guren-cli-public-disk-descendant-')
      try {
        const files = await app(workspace.dir, './storage/app')
        await mkdir(join(workspace.dir, 'storage/app/attachments/known-id'), { recursive: true })
        await symlink(join(workspace.dir, 'storage/app/attachments/known-id'), join(workspace.dir, 'public/leak'))

        expect((await run(workspace.dir, files))[0]?.status).toBe('fail')
      } finally {
        await workspace.cleanup()
      }
    })

    it('fails when the link exposes the root itself', async () => {
      const workspace = await createTempWorkspace('guren-cli-public-disk-link-root-')
      try {
        const files = await app(workspace.dir, './storage/app')
        await symlink(join(workspace.dir, 'storage/app'), join(workspace.dir, 'public/storage'))

        expect((await run(workspace.dir, files))[0]?.status).toBe('fail')
      } finally {
        await workspace.cleanup()
      }
    })
  })

  it('reports through runCheck on a whole app', async () => {
    const workspace = await createTempWorkspace('guren-cli-public-disk-runcheck-')
    try {
      await write(workspace.dir, 'config/attachments.ts', attachmentsConfig('public'))
      await write(
        workspace.dir,
        'app/Providers/StorageProvider.ts',
        storageProvider("public: { driver: 'local', root: './public/storage', url: '/storage' }"),
      )

      const report = await runCheck({ cwd: workspace.dir })

      expect(
        report.checks.find((c) => c.key.startsWith('attachments-public-disk:'))?.status,
      ).toBe('fail')
    } finally {
      await workspace.cleanup()
    }
  })
})
