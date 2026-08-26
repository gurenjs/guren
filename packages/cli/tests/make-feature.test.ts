import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { makeFeature, buildRouteRegistrationHint } from '../src/make-feature'
import { parseAttachString, parseFieldsString } from '../src/fields'
import { API_ONLY_REFUSAL, API_ROUTES_FIXTURE, createTempWorkspace, DEFAULT_ROUTES_FIXTURE, seedApiOnlyApp, seedAttachmentsConfig } from './helpers'

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

  // The name lands in an object key and a property access, so a non-identifier
  // silently produced a page that could not be parsed.
  it('throws for a field name that is not an identifier', () => {
    expect(() => parseFieldsString('my-name:string')).toThrow('Invalid field name')
    expect(() => parseFieldsString('2fa:boolean')).toThrow('Invalid field name')
    expect(() => parseFieldsString('_meta:json')).not.toThrow()
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

describe('parseAttachString', () => {
  it('parses collections with kinds', () => {
    expect(parseAttachString('cover:one,images:many')).toEqual([
      { name: 'cover', kind: 'one' },
      { name: 'images', kind: 'many' },
    ])
  })

  it('defaults the kind to one when omitted', () => {
    expect(parseAttachString('cover')).toEqual([{ name: 'cover', kind: 'one' }])
  })

  it('returns no collections for an empty string', () => {
    expect(parseAttachString('')).toEqual([])
    expect(parseAttachString('  ')).toEqual([])
  })

  it('handles whitespace', () => {
    expect(parseAttachString(' cover : one , images : many ')).toEqual([
      { name: 'cover', kind: 'one' },
      { name: 'images', kind: 'many' },
    ])
  })

  it('throws for an invalid kind', () => {
    expect(() => parseAttachString('cover:two')).toThrow('Invalid attachment kind')
  })

  it('throws for an empty or non-identifier name', () => {
    expect(() => parseAttachString(':one')).toThrow('Invalid attachment definition')
    expect(() => parseAttachString('cover-image:one')).toThrow('Invalid attachment name')
  })

  // A repeated collection is a duplicate object key in the generated
  // Attachable declaration — the second silently wins, so it is refused.
  it('throws for a duplicate collection', () => {
    expect(() => parseAttachString('cover:one,cover:many')).toThrow('Duplicate attachment collection')
  })
})

describe('makeFeature --attach', () => {
  it('wraps the model in Attachable and wires store/destroy', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-attach-')

    try {
      await seedAttachmentsConfig(workspace.dir)
      await makeFeature('Post', { fields: 'title:string', attach: 'cover:one,images:many' })

      const model = await readFile(join(workspace.dir, 'app/Models/Post.ts'), 'utf8')
      expect(model).toContain("import { Attachable, defineModel, hasManyAttached, hasOneAttached } from '@guren/core'")
      expect(model).toContain('export class Post extends Attachable(defineModel(posts), {')
      expect(model).toContain("  cover: hasOneAttached({ image: 'require' }),")
      expect(model).toContain("  images: hasManyAttached({ image: 'require' }),")

      const controller = await readFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'utf8',
      )
      const storeBody = controller.slice(controller.indexOf('async store'), controller.indexOf('async edit'))
      expect(storeBody).toContain("const cover = await this.file('cover')")
      expect(storeBody).toContain("await Post.attach(post.id, 'cover', cover)")
      expect(storeBody).toContain("for (const file of await this.files('images'))")
      expect(storeBody).toContain("await Post.attach(post.id, 'images', file)")
      // Attach runs after create (it needs the id) and before the redirect.
      expect(storeBody.indexOf('Post.create(data)')).toBeLessThan(storeBody.indexOf("this.file('cover')"))
      expect(storeBody.indexOf("Post.attach(post.id, 'images'")).toBeLessThan(storeBody.indexOf('this.redirect'))

      // Deletion is explicit (RFC 0013 §8): purge before the row goes away.
      const destroyBody = controller.slice(controller.indexOf('async destroy'))
      expect(destroyBody).toContain('await Post.purgeAttachments(post.id)')
      expect(destroyBody.indexOf('Post.purgeAttachments')).toBeLessThan(destroyBody.indexOf('Post.delete'))
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses --attach when the app has no configureAttachments()', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-attach-missing-')

    try {
      await expect(
        makeFeature('Post', { fields: 'title:string', attach: 'cover:one' }),
      ).rejects.toThrow(/guren add attachments/)

      // Refused before the first write — no half-scaffolded feature.
      expect(existsSync(join(workspace.dir, 'app/Http/Validators/PostValidator.ts'))).toBe(false)
      expect(existsSync(join(workspace.dir, 'app/Models/Post.ts'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  it('refuses a collection name that collides with a field', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-attach-collision-')

    try {
      await seedAttachmentsConfig(workspace.dir)
      await expect(
        makeFeature('Post', { fields: 'cover:string', attach: 'cover:one' }),
      ).rejects.toThrow(/collides/)
      await expect(
        makeFeature('Post', { fields: 'title:string', attach: 'post:one' }),
      ).rejects.toThrow(/collides/)
    } finally {
      await workspace.cleanup()
    }
  })

  it('leaves the model and controller unchanged without --attach', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-no-attach-')

    try {
      await makeFeature('Post', { fields: 'title:string' })

      const model = await readFile(join(workspace.dir, 'app/Models/Post.ts'), 'utf8')
      expect(model).not.toContain('Attachable')

      const controller = await readFile(
        join(workspace.dir, 'app/Http/Controllers/PostController.ts'),
        'utf8',
      )
      expect(controller).not.toContain('attach')
      expect(controller).not.toContain('purgeAttachments')
    } finally {
      await workspace.cleanup()
    }
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
      // Read without a cast: this renderer does not own the column, so the
      // conversion has to take whatever the author's schema yields.
      expect(resource).toContain(
        'startsAt: new Date(this.resource.startsAt).toISOString()',
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

  // Pins the emitted read per field type; the rule and its exceptions are
  // stated once, at `resourceFieldExpression()`.
  it('reads columns off the record without casting, json excepted', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-casts-')

    try {
      await makeFeature('Event', { fields: 'title:string,body:text?,meta:json,seats:number?' })

      const resource = await readFile(
        join(workspace.dir, 'app/Http/Resources/EventResource.ts'),
        'utf8',
      )

      expect(resource).toContain("id: EventRecord['id']")
      expect(resource).toContain('id: this.resource.id,')
      expect(resource).toContain('title: this.resource.title,')
      expect(resource).toContain('body: this.resource.body ?? null,')
      expect(resource).toContain('seats: this.resource.seats ?? null,')
      expect(resource).toContain('meta: this.resource.meta as Record<string, unknown>,')

      // The #123 rule for the key, kept as a negative because a regression
      // would land on a line the positives above do not name.
      expect(resource).not.toContain('as number')

      expect(resource).toContain(
        'export class EventResource extends Resource<EventRecord, EventResourceData>',
      )
      expect(resource).not.toContain('override toJSON')
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
      expect(newPage).toContain('defaultValue={jsonText.meta}')
      expect(newPage).toContain("setData('meta', JSON.parse(event.target.value))")
      expect(newPage).toContain('meta: {}')

      // Without the flag, submitting half-typed JSON silently sends the last
      // value that parsed, with the textarea still showing the newer text.
      expect(newPage).toContain("import { useState } from 'react'")
      expect(newPage).toContain('const [jsonErrors, setJsonErrors] = useState<Record<string, boolean>>({})')
      expect(newPage).toContain('setJsonErrors((prev) => ({ ...prev, meta: true }))')
      expect(newPage).toContain('{jsonErrors.meta && (')

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

  // Two fields differing only in punctuation used to generate one identifier —
  // `_meta` and `meta` both became `setMetaInvalid`, a duplicate declaration.
  it('keeps two similarly named json fields apart', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-json-names-')

    try {
      await makeFeature('Thing', { fields: '_meta:json,meta:json' })

      const newPage = await readFile(join(workspace.dir, 'resources/js/pages/things/New.tsx'), 'utf8')

      expect(newPage).toContain('{jsonErrors._meta && (')
      expect(newPage).toContain('{jsonErrors.meta && (')
      // One hook pair for the page, not one per field.
      expect(newPage.match(/useState/g)).toHaveLength(3)
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
        // No json field, so nothing on the page needs state.
        expect(source).not.toContain('useState')
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

describe('buildRouteRegistrationHint', () => {
  // Scaffolded registrars — the default app template and every `make:module`
  // module — name their parameter `router`. The printed block is meant to be
  // pasted in as-is, so it may only reference `router` and names it binds itself.
  const REGISTRAR_PARAM = 'router'

  it('only references identifiers a scaffolded registrar actually has', () => {
    const lines = buildRouteRegistrationHint({
      singular: 'Post', routeName: 'posts', routeVar: 'posts', withAuth: true,
    })

    const bound = new Set([REGISTRAR_PARAM, 'posts'])
    for (const declaration of lines.join('\n').matchAll(/\bconst (\w+) =/gu)) {
      bound.add(declaration[1] as string)
    }

    for (const receiver of lines.join('\n').matchAll(/^\s*(\w+)\./gmu)) {
      expect(bound).toContain(receiver[1] as string)
    }
  })

  it('binds a fresh name from the registrar parameter instead of shadowing it', () => {
    const [aliasLine] = buildRouteRegistrationHint({
      singular: 'Post', routeName: 'posts', routeVar: 'posts', withAuth: true,
    })

    // Capturing the return value is what puts 'auth' in the router's type; a bare
    // `router.aliasMiddleware(...)` leaves every `.middleware('auth')` below broken.
    expect(aliasLine).toMatch(/^const (\w+) = router\.aliasMiddleware\('auth', /u)
    expect(aliasLine).not.toContain(`const ${REGISTRAR_PARAM} =`)
  })

  it('omits the alias registration and middleware suffixes when --public', () => {
    const lines = buildRouteRegistrationHint({
      singular: 'Post', routeName: 'posts', routeVar: 'posts', withAuth: false,
    })

    expect(lines.join('\n')).not.toContain('aliasMiddleware')
    expect(lines.join('\n')).not.toContain(".middleware('auth')")
    expect(lines[0]).toBe(`${REGISTRAR_PARAM}.group('/posts', (posts) => {`)
  })
})

// `guren make:feature` reaches this scaffold without passing through the
// blueprint registry, so the refusal has to live here too — the resource
// blueprint's own guard cannot cover the direct command. The predicate's
// branches are pinned in the admin block of blueprints.test.ts; this only has
// to prove makeFeature() refuses before its first write.
describe('makeFeature on an API-only app', () => {
  it('refuses, naming the two signals, and writes nothing', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-api-only-')
    try {
      await seedApiOnlyApp(workspace.dir)

      await expect(makeFeature('Post', { fields: 'title:string' })).rejects.toThrow(API_ONLY_REFUSAL)

      for (const path of [
        'app/Models/Post.ts',
        'app/Http/Controllers/PostController.ts',
        'app/Http/Resources/PostResource.ts',
        'app/Http/Validators/PostValidator.ts',
        'resources/js/pages/posts/Index.tsx',
      ]) {
        expect(existsSync(join(workspace.dir, path))).toBe(false)
      }
      expect(await readFile(join(workspace.dir, 'routes/api.ts'), 'utf8')).toBe(API_ROUTES_FIXTURE)
    } finally {
      await workspace.cleanup()
    }
  })

  // The guard judges `writeRoot(options)`, and this is the test that keeps it
  // that way: `guren mcp` names the workspace it scaffolds into rather than
  // steering the server process there, so reading the process directory would
  // judge a project the files are never written to.
  it('judges the project named by cwd, not the process directory', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-api-only-cwd-')
    try {
      // The process directory is a fullstack app; the target is not.
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'routes/web.ts'), DEFAULT_ROUTES_FIXTURE, 'utf8')
      const target = join(workspace.dir, 'api-app')
      await seedApiOnlyApp(target)

      await expect(makeFeature('Post', { fields: 'title:string', cwd: target })).rejects.toThrow(
        API_ONLY_REFUSAL,
      )
      expect(existsSync(join(target, 'resources/js/pages/posts/Index.tsx'))).toBe(false)
    } finally {
      await workspace.cleanup()
    }
  })

  // Positive evidence only: no manifest is an unknown app, not an API-only one.
  // The shared predicate is tested elsewhere; this pins that the guard at this
  // call site cannot misfire into refusing an app it cannot judge.
  it('still scaffolds when there is no package.json to judge by', async () => {
    const workspace = await createTempWorkspace('guren-cli-feature-unknown-app-')
    try {
      await mkdir(join(workspace.dir, 'routes'), { recursive: true })
      await writeFile(join(workspace.dir, 'routes/api.ts'), API_ROUTES_FIXTURE, 'utf8')

      const created = await makeFeature('Post', { fields: 'title:string', announce: false })

      expect(created.some((file) => file.endsWith('resources/js/pages/posts/Index.tsx'))).toBe(true)
    } finally {
      await workspace.cleanup()
    }
  })
})
