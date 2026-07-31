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

      const storeBody = controller.slice(controller.indexOf('async store'), controller.indexOf('async update'))
      expect(storeBody).toContain('await this.auth.userOrFail()')
      const updateBody = controller.slice(controller.indexOf('async update'), controller.indexOf('async destroy'))
      expect(updateBody).toContain('await this.auth.userOrFail()')

      // Without --module, redirects stay unprefixed — matches the top-level
      // router.group('/posts', ...) the printed next-steps ask for.
      expect(controller).toContain("this.redirect('/posts/' + post?.id)")
      expect(controller).toContain("this.redirect('/posts/' + id)")

      const destroyBody = controller.slice(controller.indexOf('async destroy'))
      expect(destroyBody).toContain('await this.auth.userOrFail()')
      expect(destroyBody).toContain('await Post.findOrFail(id)')
      expect(destroyBody).toContain('await Post.delete({ id: post.id })')
      expect(destroyBody).toContain("this.redirect('/posts')")
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
      expect(controller).toContain("await this.authorize('delete', [Post, post])")

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
      expect(controller).toContain('async destroy')
      expect(controller).toContain('await Post.findOrFail(id)')
      expect(controller).toContain('await Post.delete({ id: post.id })')
    } finally {
      await workspace.cleanup()
    }
  })

  it('generates a delete button on the Show page', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-show-delete-')

    try {
      await makeFeature('Post', { fields: 'title:string' })

      const showPage = await readFile(
        join(workspace.dir, 'resources/js/pages/posts/Show.tsx'),
        'utf8',
      )

      expect(showPage).toContain("href={route('posts.destroy', { id: post.id })}")
      expect(showPage).toContain('method="delete"')
      expect(showPage).toContain("onBefore={() => window.confirm('Delete this post?')}")
    } finally {
      await workspace.cleanup()
    }
  })

  // A date column is a `Date` in the database, an ISO string on the wire, and a
  // bare `YYYY-MM-DD` in a date input. Each layer has to name its own shape or
  // the scaffold does not type-check — see the RouteBody note below.
  it('keeps a date field a string all the way through the form', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-date-')

    try {
      await makeFeature('Event', { fields: 'startsAt:date' })

      const resource = await readFile(
        join(workspace.dir, 'app/Http/Resources/EventResource.ts'),
        'utf8',
      )
      expect(resource).toContain('startsAt: string')
      // Casting the column straight to string is what TypeScript rejects, and
      // calling .toISOString() on it breaks under SQLite, where the driver
      // hands back a string rather than a Date.
      expect(resource).toContain(
        'startsAt: new Date(this.resource.startsAt as string | number | Date).toISOString()',
      )

      const newPage = await readFile(join(workspace.dir, 'resources/js/pages/events/New.tsx'), 'utf8')
      // `type="date"` renders nothing for a full ISO timestamp.
      expect(newPage).toContain('value={form.data.startsAt.slice(0, 10)}')
      expect(newPage).toContain("setData('startsAt', event.target.value)")
      expect(newPage).toContain("startsAt: ''")
    } finally {
      await workspace.cleanup()
    }
  })

  it('edits a json field as text without letting mid-edit JSON clear it', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-json-')

    try {
      await makeFeature('Event', { fields: 'meta:json' })

      const validator = await readFile(
        join(workspace.dir, 'app/Http/Validators/EventValidator.ts'),
        'utf8',
      )
      // Zod 4 requires the key type; `any` keeps the value assignable to
      // Inertia's FormDataType, which rejects `unknown`.
      expect(validator).toContain('meta: z.record(z.string(), z.any())')

      const newPage = await readFile(join(workspace.dir, 'resources/js/pages/events/New.tsx'), 'utf8')
      // Uncontrolled: a controlled textarea would reject every keystroke that
      // leaves the JSON temporarily unparseable.
      expect(newPage).toContain('defaultValue={JSON.stringify(form.data.meta, null, 2)}')
      expect(newPage).toContain("setData('meta', JSON.parse(event.target.value))")
      expect(newPage).toContain('meta: {}')

      // Without the flag, submitting half-typed JSON silently sends the last
      // value that parsed, with the textarea still showing the newer text.
      expect(newPage).toContain("import { useState } from 'react'")
      expect(newPage).toContain('const [metaInvalid, setMetaInvalid] = useState(false)')
      expect(newPage).toContain('setMetaInvalid(true)')
      expect(newPage).toContain('{metaInvalid && (')

      const showPage = await readFile(join(workspace.dir, 'resources/js/pages/events/Show.tsx'), 'utf8')
      // An object is not a valid React child.
      expect(showPage).toContain('{JSON.stringify(event.meta)}')
    } finally {
      await workspace.cleanup()
    }
  })

  it('does not headline the Index page with a json field', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-index-json-')

    try {
      // json first, so the naive "first field is the title" pick would land on
      // it and render an object as a React child.
      await makeFeature('Event', { fields: 'meta:json,title:string,note:text' })

      const indexPage = await readFile(join(workspace.dir, 'resources/js/pages/events/Index.tsx'), 'utf8')

      expect(indexPage).not.toContain('{event.meta}')
      expect(indexPage).toContain('{event.title}')
      expect(indexPage).toContain('{event.note ?? \'\'}')
    } finally {
      await workspace.cleanup()
    }
  })

  it('only imports useState on pages that need field state', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-no-state-')

    try {
      await makeFeature('Post', { fields: 'title:string,body:text' })

      const newPage = await readFile(join(workspace.dir, 'resources/js/pages/posts/New.tsx'), 'utf8')
      expect(newPage).not.toContain('useState')
    } finally {
      await workspace.cleanup()
    }
  })

  it('derives form types through RouteBody rather than indexing ApiRoutes', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-routebody-')

    try {
      await makeFeature('Post', { fields: 'title:string' })

      for (const page of ['New.tsx', 'Edit.tsx']) {
        const source = await readFile(join(workspace.dir, 'resources/js/pages/posts', page), 'utf8')
        expect(source).toContain("type PostFormData = RouteBody<ApiRoutes, 'posts.store'>")
        expect(source).toContain("from '@guren/inertia-client/typed-forms'")
        // The record is named `post` here, but an entity whose variable name is
        // `event` would collide with a submit handler that also took `event`.
        expect(source).toContain('onSubmit={(submitEvent) =>')
      }
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
      expect(controllerContent).toContain("this.redirect('/billing/invoices')")
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
