import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeFeature, parseFieldsString } from '../src/make-feature'
import { createTempWorkspace } from './helpers'

describe('parseFieldsString', () => {
  it('parses simple fields', () => {
    const fields = parseFieldsString('title:string,body:text')
    expect(fields).toHaveLength(2)
    expect(fields[0]).toEqual({ name: 'title', type: 'string', nullable: false })
    expect(fields[1]).toEqual({ name: 'body', type: 'text', nullable: false })
  })

  it('parses nullable fields', () => {
    const fields = parseFieldsString('body:text?,published:boolean')
    expect(fields[0]).toEqual({ name: 'body', type: 'text', nullable: true })
    expect(fields[1]).toEqual({ name: 'published', type: 'boolean', nullable: false })
  })

  it('supports all field types', () => {
    const fields = parseFieldsString('a:string,b:number,c:boolean,d:text,e:date,f:json')
    expect(fields).toHaveLength(6)
    expect(fields.map(f => f.type)).toEqual(['string', 'number', 'boolean', 'text', 'date', 'json'])
  })

  it('returns defaults for empty string', () => {
    const fields = parseFieldsString('')
    expect(fields).toHaveLength(2)
    expect(fields[0].name).toBe('title')
    expect(fields[1].name).toBe('body')
  })

  it('throws for invalid field type', () => {
    expect(() => parseFieldsString('name:invalid')).toThrow('Invalid field type')
  })

  it('throws for empty field name', () => {
    expect(() => parseFieldsString(':string')).toThrow('Invalid field definition')
  })

  it('handles whitespace', () => {
    const fields = parseFieldsString(' title : string , body : text ')
    expect(fields).toHaveLength(2)
    expect(fields[0].name).toBe('title')
    expect(fields[1].name).toBe('body')
  })

  it('defaults type to string when omitted', () => {
    const fields = parseFieldsString('title')
    expect(fields[0].type).toBe('string')
  })
})

describe('makeFeature', () => {
  it('includes auth checks in mutating actions by default', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-auth-')

    try {
      await makeFeature('Post', { fields: 'title:string' })

      const controller = await readFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'utf8',
      )

      const storeBody = controller.slice(controller.indexOf('async store'))
      expect(storeBody).toContain('await this.auth.userOrFail()')
      const updateBody = controller.slice(controller.indexOf('async update'))
      expect(updateBody).toContain('await this.auth.userOrFail()')

      // Without --module, redirects stay unprefixed — matches the top-level
      // router.group('/posts', ...) the printed next-steps ask for.
      expect(controller).toContain("this.redirect('/posts/' + post?.id)")
      expect(controller).toContain("this.redirect('/posts/' + id)")
    } finally {
      await workspace.cleanup()
    }
  })

  it('generates a policy and authorize calls with withPolicy', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-policy-')

    try {
      await makeFeature('Post', { fields: 'title:string', withPolicy: true })

      const controller = await readFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'utf8',
      )
      expect(controller).toContain("await this.authorize('create', Post)")
      expect(controller).toContain("await this.authorize('update', [Post, await Post.findOrFail(id)])")

      const policy = await readFile(
        join(workspace.dir, 'app/Policies/PostPolicy.ts'),
        'utf8',
      )
      expect(policy).toContain('export class PostPolicy extends Policy')
    } finally {
      await workspace.cleanup()
    }
  })

  it('skips auth checks with publicAccess', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-public-')

    try {
      await makeFeature('Post', { fields: 'title:string', publicAccess: true })

      const controller = await readFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'utf8',
      )

      expect(controller).not.toContain('auth.userOrFail')
      expect(controller).toContain('validateBody')
    } finally {
      await workspace.cleanup()
    }
  })

  it('scaffolds app/ files under modules/<name>/ but namespaces pages instead of colocating them (--module)', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-module-')

    try {
      const created = await makeFeature('Invoice', { fields: 'title:string', root: 'billing' })

      // app/ output moves under modules/<name>/ ...
      expect(created.some((f) => f.endsWith('modules/billing/app/Http/Controllers/InvoiceController.ts'))).toBe(true)
      expect(created.some((f) => f.endsWith('modules/billing/app/Models/Invoice.ts'))).toBe(true)

      // ... but pages stay top-level, namespaced by module name per RFC 0002's
      // "pages are not colocated" decision — NOT modules/billing/resources/js/pages/.
      expect(created.some((f) => f.endsWith('resources/js/pages/billing/invoices/Index.tsx'))).toBe(true)
      expect(created.some((f) => f.includes('modules/billing/resources'))).toBe(false)

      const controllerContent = await readFile(
        join(workspace.dir, 'modules/billing/app/Http/Controllers/InvoiceController.ts'),
        'utf8',
      )
      expect(controllerContent).toContain('class InvoiceController')

      // The generated pages.gen.ts nests every resources/js/pages/ directory
      // segment (see pages-types.ts), so a page at
      // resources/js/pages/billing/invoices/Index.tsx is reached via
      // pages.billing.invoices.Index — not pages.invoices.Index. The
      // controller must reference the module-namespaced path or codegen
      // output and generated code disagree.
      expect(controllerContent).toContain('pages.billing.invoices.Index')
      expect(controllerContent).toContain('pages.billing.invoices.Show')
      expect(controllerContent).toContain('pages.billing.invoices.New')
      expect(controllerContent).toContain('pages.billing.invoices.Edit')
      expect(controllerContent).not.toMatch(/this\.inertia\(pages\.invoices\./)

      // store()/update() redirect to the resource's own show page. Once
      // --module moves this route under the module's prefix (make:module's
      // own default is `/<name>`), a bare '/invoices/' + id redirect 404s —
      // it must match make:module's default prefix.
      expect(controllerContent).toContain("this.redirect('/billing/invoices/' + invoice?.id)")
      expect(controllerContent).toContain("this.redirect('/billing/invoices/' + id)")
    } finally {
      await workspace.cleanup()
    }
  })

  it('bracket-quotes a module name that is not a valid identifier (--module)', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-module-hyphen-')

    try {
      const created = await makeFeature('Invoice', { fields: 'title:string', root: 'billing-ops' })
      const controllerPath = created.find((f) => f.endsWith('modules/billing-ops/app/Http/Controllers/InvoiceController.ts'))
      expect(controllerPath).toBeDefined()

      const controllerContent = await readFile(controllerPath as string, 'utf8')
      expect(controllerContent).toContain("pages['billing-ops'].invoices.Index")
    } finally {
      await workspace.cleanup()
    }
  })
})
