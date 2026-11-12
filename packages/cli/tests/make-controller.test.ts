import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { controllerNextStep, makeController } from '../src/make-controller'
import { makeView } from '../src/make-view'
import { seedApiOnlyApp, seedShippedApiOnlyApp } from './helpers'

describe('makeController', () => {
  let tempDir: string
  let originalCwd: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'guren-cli-controller-test-'))
    originalCwd = process.cwd()
    process.chdir(tempDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('creates a controller file with correct name', async () => {
    const result = await makeController('User')

    expect(result).toContain('UserController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('export default class UserController extends Controller')
  })

  it('appends Controller suffix if not present', async () => {
    const result = await makeController('Post')

    expect(result).toContain('PostController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class PostController')
  })

  it('does not duplicate Controller suffix', async () => {
    const result = await makeController('CommentController')

    expect(result).toContain('CommentController.ts')
    expect(result).not.toContain('CommentControllerController')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class CommentController')
    expect(content).not.toContain('CommentControllerController')
  })

  it('converts kebab-case names to PascalCase', async () => {
    const result = await makeController('user-profile')

    expect(result).toContain('UserProfileController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class UserProfileController')
  })

  it('converts snake_case names to PascalCase', async () => {
    const result = await makeController('blog_post')

    expect(result).toContain('BlogPostController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class BlogPostController')
  })

  it('creates file in correct directory structure', async () => {
    const result = await makeController('Dashboard')

    expect(result).toContain('app/Http/Controllers/DashboardController.ts')
  })

  it('generates correct inertia path in template', async () => {
    const result = await makeController('AdminSettings')

    const content = await readFile(result, 'utf8')
    expect(content).toContain("inertia(pages.adminSettings.Index")
    expect(content).not.toContain('TODO')
  })

  it('includes correct imports in template', async () => {
    const result = await makeController('Test')

    const content = await readFile(result, 'utf8')
    expect(content).toContain("import { Controller } from '@guren/core'")
  })

  it('throws error if file already exists without force flag', async () => {
    await makeController('Existing')

    await expect(makeController('Existing')).rejects.toThrow('already exists')
  })

  it('overwrites existing file with force flag', async () => {
    await makeController('Overwrite')
    const result = await makeController('Overwrite', { force: true })

    expect(result).toContain('OverwriteController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class OverwriteController')
  })

  it('creates parent directories if they do not exist', async () => {
    const result = await makeController('Nested')

    const fileExists = await access(result).then(() => true).catch(() => false)
    expect(fileExists).toBe(true)
  })

  it('scaffolds under modules/<name>/ when root is set (--module)', async () => {
    const result = await makeController('Invoice', { root: 'billing' })

    expect(result).toContain('modules/billing/app/Http/Controllers/InvoiceController.ts')

    const content = await readFile(result, 'utf8')
    expect(content).toContain('class InvoiceController')

    // pages.gen.ts nests by directory segment, so the reference must be
    // namespaced by module (pages-types.ts).
    expect(content).toContain('inertia(pages.billing.invoice.Index')
  })

  it('kebab-cases a PascalCase root the same way make:module does', async () => {
    const result = await makeController('Invoice', { root: 'Billing' })

    expect(result).toContain('modules/billing/app/Http/Controllers/InvoiceController.ts')
  })

  it('rejects a --module value that would escape modules/ (path traversal)', async () => {
    await expect(makeController('Invoice', { root: '../../outside' })).rejects.toThrow(/Invalid module name/)
  })

  describe('controllerNextStep', () => {
    const hintedCommand = (step: string | undefined): string => /bunx guren (make:view .+)$/u.exec(step ?? '')?.[1] ?? ''
    const hintedView = (step: string | undefined): string => /^make:view (\S+)$/u.exec(hintedCommand(step))?.[1] ?? ''

    it('should name the page the scaffolded action renders and the command that writes it', async () => {
      await makeController('Comment')

      const step = await controllerNextStep('Comment')

      expect(step).toContain('pages.comment.Index')
      expect(hintedView(step)).toBe('comment/Index')
    })

    it('should name the directory by the accessor key, not the kebab-cased name', async () => {
      const content = await readFile(await makeController('user-profile'), 'utf8')

      expect(content).toContain('inertia(pages.userProfile.Index')
      expect(hintedView(await controllerNextStep('user-profile'))).toBe('userProfile/Index')
    })

    it('should name a module controller page with the --module the controller was scaffolded with', async () => {
      await makeController('Invoice', { root: 'billing' })

      const step = await controllerNextStep('Invoice', { root: 'billing' })

      expect(step).toContain('pages.billing.invoice.Index')
      expect(hintedCommand(step)).toBe('make:view invoice/Index --module billing')
    })

    it('should return nothing once the hinted command has written the page', async () => {
      await makeController('Invoice', { root: 'billing' })
      expect(hintedCommand(await controllerNextStep('Invoice', { root: 'billing' }))).toBe(
        'make:view invoice/Index --module billing',
      )

      const written = await makeView('invoice/Index', { root: 'billing' })

      expect(written).toContain('resources/js/pages/billing/invoice/Index.tsx')
      expect(await controllerNextStep('Invoice', { root: 'billing' })).toBeUndefined()
    })

    it('should return nothing on an API-only app, whose controller renders no page', async () => {
      await seedApiOnlyApp(tempDir)
      await makeController('User')

      expect(await controllerNextStep('User')).toBeUndefined()
    })
  })

  // Only the wiring is pinned here — "cannot tell" keeps Inertia via the tests
  // above; the predicate's own branches are pinned in blueprints.test.ts.
  describe('on an API-only app', () => {
    it('emits a JSON controller instead of the Inertia template', async () => {
      await seedApiOnlyApp(tempDir)

      const result = await makeController('User')

      const content = await readFile(result, 'utf8')
      expect(content).toContain('return this.json(')
      expect(content).toContain('class UserController extends Controller')
      expect(content).not.toContain('pages.gen')
      expect(content).not.toContain('this.inertia(')
    })

    // The predicate must judge the root the file is written into, not the
    // process directory — an explicit cwd names a different app.
    it('judges the app at an explicit cwd, not the process directory', async () => {
      const apiAppDir = await mkdtemp(join(tmpdir(), 'guren-cli-controller-api-cwd-'))
      try {
        await seedApiOnlyApp(apiAppDir)

        // process.cwd() is tempDir: no manifest at all, so judged there the
        // template would stay Inertia.
        const result = await makeController('User', { cwd: apiAppDir })

        expect(result).toContain(join(apiAppDir, 'app/Http/Controllers/UserController.ts'))
        expect(await readFile(result, 'utf8')).toContain('return this.json(')
      } finally {
        await rm(apiAppDir, { recursive: true, force: true })
      }
    })

    // The fixture above is a reduction of what `create-guren-app` ships: a
    // starter that quietly gained the client would hand users the Inertia
    // template back with every synthetic test still green.
    it('emits the JSON dialect for the api-only template as shipped', async () => {
      await seedShippedApiOnlyApp(tempDir)

      const result = await makeController('User')

      expect(await readFile(result, 'utf8')).toContain('return this.json(')
    })

    // Judged at the app root: a probe against modules/billing/ would find
    // neither signal and answer "cannot tell" for a confirmed API-only app.
    it('emits the JSON dialect under --module too, judging the app root', async () => {
      await seedApiOnlyApp(tempDir)

      const result = await makeController('Invoice', { root: 'billing' })

      expect(result).toContain('modules/billing/app/Http/Controllers/InvoiceController.ts')
      expect(await readFile(result, 'utf8')).toContain('return this.json(')
    })
  })
})
