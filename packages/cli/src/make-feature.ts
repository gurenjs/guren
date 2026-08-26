import { consola } from 'consola'
import { assertNotApiOnly } from './app-surface'
import { camelCase, kebabCase, pagesAccessor, pascalCase, safeModuleName, writeRoot, writeScaffoldFiles, writerOptionsFrom, type WriterOptions } from './utils'
import { pluralize } from './inflect'
import { makeModel } from './make-model'
import { makePolicy } from './make-policy'
import { makeTest } from './make-test'
import { makeValidator } from './make-validator'
import { parseFieldsString, type FieldDefinition, type FieldType } from './fields'
import { ensureGurenUiTokens } from './guren-css'
import { schemaPathFor } from './schema-parser'

/**
 * The alternative the API-only refusal names, shared with the resource
 * blueprint: both doors lead to this one scaffold, so they point at the same
 * way out.
 *
 * It names `make:controller` rather than telling the reader to write the file:
 * on the app this refusal fires for, that command emits the JSON controller
 * itself.
 */
export const API_ONLY_FEATURE_ALTERNATIVE = 'Scaffold a JSON controller with guren make:controller and register it in routes/api.ts'

export interface MakeFeatureOptions extends WriterOptions {
  fields?: string
  withTest?: boolean
  withFactory?: boolean
  /** Skip authentication checks in mutating actions. Defaults to false (auth required). */
  publicAccess?: boolean
  /** Also generate an authorization policy and enforce it in mutating actions. */
  withPolicy?: boolean
  /** Print created files and next steps (default: true). Callers that wire routes/schema themselves pass false. */
  announce?: boolean
}

export async function makeFeature(name: string, options: MakeFeatureOptions = {}): Promise<string[]> {
  const fields = parseFieldsString(options.fields ?? '')
  const singular = pascalCase(name)
  const collection = pluralize(singular)
  const routeName = kebabCase(collection)
  const routeVar = camelCase(routeName)
  const variableName = singular.charAt(0).toLowerCase() + singular.slice(1)
  const withAuth = !options.publicAccess
  const withPolicy = Boolean(options.withPolicy)
  const writerOptions: WriterOptions = writerOptionsFrom(options)

  // `--module <name>` moves app/ output under modules/<name>/ (handled by
  // scaffoldFile for makeModel/makePolicy/makeTest below), but pages are
  // NOT colocated per RFC 0002's initial scope — they stay under the
  // top-level resources/js/pages/, namespaced by the module name instead
  // (resources/js/pages/<module>/<routeName>/...).
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const appPrefix = moduleName ? `modules/${moduleName}/` : ''
  const pagePrefix = moduleName ? `${moduleName}/` : ''

  // Same ordering rule as the resource blueprint's guard: everything above is
  // pure, so a usage error is reported as one, and the check still precedes
  // the first write below. It lives here as well because `guren make:feature`
  // reaches this scaffold without passing through the blueprint registry.
  // Judged at `writeRoot()` — this command honours `options.cwd`, so the app
  // judged must be the app written into.
  await assertNotApiOnly(writeRoot(options), {
    does: 'guren make:feature scaffolds Inertia pages and a controller that returns Inertia responses',
    instead: API_ONLY_FEATURE_ALTERNATIVE,
  })

  // Composed rather than emitted inline — the same way makeModel/makePolicy/
  // makeTest are below — so the schema names the generated controller imports
  // and the ones `make:validator` writes cannot drift apart.
  const validatorPath = await makeValidator(singular, { ...writerOptions, fields })

  const created = await writeScaffoldFiles([
    {
      path: `${appPrefix}app/Http/Resources/${singular}Resource.ts`,
      contents: generateResource(singular, fields),
    },
    {
      path: `${appPrefix}app/Http/Controllers/${singular}Controller.ts`,
      contents: generateController(singular, collection, routeName, routeVar, variableName, fields, withAuth, withPolicy, moduleName),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/Index.tsx`,
      contents: generateIndexPage(singular, collection, routeName, variableName, fields, appPrefix),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/Show.tsx`,
      contents: generateShowPage(singular, routeName, variableName, fields, appPrefix),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/New.tsx`,
      contents: generateNewPage(singular, routeName, fields),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/Edit.tsx`,
      contents: generateEditPage(singular, routeName, variableName, fields),
    },
  ], writerOptions)

  // The pages above style with the Guren UI tokens (bg-g-page, …) — make
  // sure the app actually loads them.
  await ensureGurenUiTokens(writeRoot(writerOptions))

  created.unshift(validatorPath)

  // Create model
  const modelPath = await makeModel(singular, writerOptions)
  created.push(modelPath)

  // Optionally create policy
  if (withPolicy) {
    const policyPath = await makePolicy(singular, writerOptions)
    created.push(policyPath)
  }

  // Optionally create test
  if (options.withTest) {
    try {
      const testPath = await makeTest(singular, writerOptions)
      created.push(testPath)
    } catch {
      // Ignore if test creation fails
    }
  }

  if (options.announce === false) {
    return created
  }

  for (const file of created) {
    consola.success(`Created ${file}`)
  }

  const schemaPath = schemaPathFor(moduleName)
  const routesPath = moduleName ? `modules/${moduleName}/routes.ts` : 'routes/web.ts'
  const controllerImportPath = moduleName ? './app/Http/Controllers' : '../app/Http/Controllers'
  const validatorImportPath = moduleName ? './app/Http/Validators' : '../app/Http/Validators'
  consola.info('')
  consola.info('Next steps:')
  consola.info(`  1. Add table definition to ${schemaPath}`)
  consola.info(`  2. Register routes in ${routesPath} with body schemas:`)
  consola.info(`     import ${singular}Controller from '${controllerImportPath}/${singular}Controller.js'`)
  consola.info(`     import { ${singular}PayloadSchema } from '${validatorImportPath}/${singular}Validator.js'`)
  for (const line of buildRouteRegistrationHint({ singular, routeName, routeVar, withAuth })) {
    consola.info(`     ${line}`)
  }
  consola.info(`  3. Run: bunx guren db:migrate`)
  consola.info(`  4. Run: bunx guren codegen`)
  if (withPolicy) {
    const modelsBase = moduleName ? `../modules/${moduleName}` : '../app'
    consola.info(`  5. Register the policy in src/app.ts (inside the boot callback):`)
    consola.info(`     import { getGate } from '@guren/core'`)
    consola.info(`     import { ${singular} } from '${modelsBase}/Models/${singular}.js'`)
    consola.info(`     import { ${singular}Policy } from '${modelsBase}/Policies/${singular}Policy.js'`)
    consola.info(`     getGate().policy(${singular}, ${singular}Policy)`)
  }
  if (withAuth) {
    consola.info('')
    consola.info(`  Note: store/update/destroy call this.auth.userOrFail() — unauthenticated requests get 401.`)
    consola.info(`  Use --public to scaffold without authentication checks.`)
  }
  if (moduleName) {
    consola.info('')
    consola.info(`  Note: the generated redirects assume this module keeps its default`)
    consola.info(`  \`prefix: '/${moduleName}'\` from \`make:module\` — update ${singular}Controller.ts`)
    consola.info(`  if you changed modules/${moduleName}/index.ts's prefix.`)
  }

  return created
}

/**
 * The route-registration block for a resource: what `make:feature` prints for
 * the developer to paste into their registrar, and what `guren add resource`
 * writes into `routes/web.ts` directly. One builder for both, so the CRUD set
 * cannot drift between the routes an app is told to register and the ones the
 * blueprint registers for it.
 *
 * It has to compile verbatim inside `export function register*Routes(router:
 * Router)` — the shape both the default app template and `make:module`
 * scaffold — so the auth alias binds a *new* name instead of assuming a
 * differently-named parameter or shadowing `router`. Capturing that return
 * value is what puts `'auth'` into the router's type; discard it and every
 * `.middleware('auth')` below stops compiling.
 *
 * `receiver` is the router the group hangs off when there is no auth alias to
 * bind. The blueprint passes the registrar's own parameter, which is the only
 * name guaranteed to be in scope — a registrar that rebinds it (the blog
 * template's `const router = baseRouter.aliasMiddleware(...)`) does so partway
 * down the body.
 */
export function buildRouteRegistrationHint(options: {
  singular: string
  routeName: string
  routeVar: string
  withAuth: boolean
  receiver?: string
}): string[] {
  const { singular, routeName, routeVar, withAuth, receiver = 'router' } = options
  const authSuffix = withAuth ? `.middleware('auth')` : ''
  const groupRouter = withAuth ? 'authRouter' : receiver

  return [
    ...(withAuth
      ? [`const ${groupRouter} = ${receiver}.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))`]
      : []),
    `${groupRouter}.group('/${routeName}', (${routeVar}) => {`,
    `  ${routeVar}.get('/', [${singular}Controller, 'index']).name('${routeName}.index')`,
    `  ${routeVar}.get('/create', [${singular}Controller, 'create']).name('${routeName}.create')`,
    `  ${routeVar}.get('/:id', [${singular}Controller, 'show']).name('${routeName}.show')`,
    `  ${routeVar}.get('/:id/edit', [${singular}Controller, 'edit']).name('${routeName}.edit')`,
    `  ${routeVar}.post('/', { name: '${routeName}.store', body: ${singular}PayloadSchema }, [${singular}Controller, 'store'])${authSuffix}`,
    `  ${routeVar}.put('/:id', { name: '${routeName}.update', body: ${singular}PayloadSchema }, [${singular}Controller, 'update'])${authSuffix}`,
    `  ${routeVar}.delete('/:id', { name: '${routeName}.destroy' }, [${singular}Controller, 'destroy'])${authSuffix}`,
    `})`,
  ]
}

// --- Template generators ---

// Keyed by `FieldType` rather than `string`, so adding a field type fails to
// compile here instead of silently falling through to a string default.
function tsFieldType(field: FieldDefinition): string {
  const map: Record<FieldType, string> = {
    string: 'string',
    text: 'string',
    number: 'number',
    boolean: 'boolean',
    date: 'string',
    json: 'Record<string, unknown>',
  }
  const base = map[field.type]
  return field.nullable ? `${base} | null` : base
}

/**
 * How a resource reads one column off its record.
 *
 * The record is `typeof table.$inferSelect`, so every column already carries
 * its own type and reading one needs no cast. Casting anyway is not merely
 * redundant: `as string` on a column the app later makes nullable swallows the
 * `null`, and the resource keeps compiling while it lies to the frontend.
 *
 * `json` is the one exception, in every dialect: `jsonb()`, `json()` and
 * `text({ mode: 'json' })` all infer `unknown` unless the schema pins a
 * `$type`, so the declared `Record<string, unknown>` has to be asserted. The
 * assertion is unconditional, so an author who pinned a `$type` of their own
 * gets it flattened back to `Record<string, unknown>` in the payload.
 *
 * A `date` column serializes to the ISO string `tsFieldType` declares, so it is
 * converted rather than read. It goes through `new Date()` rather than a cast
 * because this renderer does not own the column: `guren add resource` writes
 * the table (and gets a `Date` in all three dialects — see `ColumnMapping` in
 * blueprints.ts), but `make:feature` leaves it to the author, whose `text`
 * column yields a string. `new Date()` takes either.
 *
 * A nullable column keeps its `?? null`. `$inferSelect` alone makes it a no-op,
 * but the record the author widens later — a `WithRelations` union, a partial
 * select — can carry `undefined`, which the declared `T | null` would reject.
 */
function resourceFieldExpression(field: FieldDefinition): string {
  const access = `this.resource.${field.name}`
  if (field.type === 'date') {
    const iso = `new Date(${access}).toISOString()`
    return field.nullable ? `${access} == null ? null : ${iso}` : iso
  }
  if (field.type === 'json') {
    const asserted = `${access} as ${tsFieldType(field)}`
    return field.nullable ? `(${asserted}) ?? null` : asserted
  }
  return field.nullable ? `${access} ?? null` : access
}

/** The empty value a form starts a field at, matching its wire type. */
function emptyFormValue(field: FieldDefinition): string {
  if (field.type === 'boolean') return 'false'
  if (field.type === 'number') return '0'
  if (field.type === 'json') return '{}'
  return "''"
}

/**
 * Reading a nullable column. It is typed `T | null | undefined`, which neither
 * a controlled input nor `useForm`'s seed accepts, so it coalesces to the same
 * empty value the form starts at. Parenthesized so the result can be used as a
 * receiver — `(a ?? '').slice(...)` — since `??` binds looser than member access.
 */
function withEmptyFallback(field: FieldDefinition, access: string): string {
  return field.nullable ? `(${access} ?? ${emptyFormValue(field)})` : access
}

function formValue(field: FieldDefinition, formVar: string): string {
  return withEmptyFallback(field, `${formVar}.data.${field.name}`)
}

function generateResource(singular: string, fields: FieldDefinition[]): string {
  // The key's type is read off the record rather than declared, the same rule
  // `make:resource` follows: `guren add resource` writes an auto-increment
  // `id`, but `make:feature` leaves the table to the author, and a hard-coded
  // `number` is wrong the moment they reach for a UUID.
  const dataFields = [
    `  id: ${singular}Record['id']`,
    ...fields.map((f) => `  ${f.name}: ${tsFieldType(f)}`),
  ].join('\n')

  const toArrayFields = [
    '      id: this.resource.id,',
    ...fields.map((f) => `      ${f.name}: ${resourceFieldExpression(f)},`),
  ].join('\n')

  return `import { Resource } from '@guren/core'
import type { ${singular}Record } from '../../Models/${singular}.js'

export interface ${singular}ResourceData extends Record<string, unknown> {
${dataFields}
}

export class ${singular}Resource extends Resource<${singular}Record, ${singular}ResourceData> {
  toArray(): ${singular}ResourceData {
    return {
${toArrayFields}
    }
  }
}
`
}

function generateController(
  singular: string,
  collection: string,
  routeName: string,
  routeVar: string,
  variableName: string,
  fields: FieldDefinition[],
  withAuth: boolean,
  withPolicy: boolean,
  moduleName: string | undefined,
): string {
  const authGuard = withAuth ? '    await this.auth.userOrFail()\n' : ''
  const createGuard = withPolicy ? `    await this.authorize('create', ${singular})\n` : ''
  const updateGuard = withPolicy
    ? `    await this.authorize('update', [${singular}, await ${singular}.findOrFail(id)])\n`
    : ''
  const pagesBase = pagesAccessor(moduleName, routeVar)
  // Redirect targets are plain path strings, not resolved through the typed
  // route() helper, so — unlike pagesBase above — this can't be verified
  // against the actual mounted path. Assumes `make:module`'s own default
  // `prefix: '/<name>'` convention; update these if the module's prefix
  // was changed after scaffolding.
  const redirectPrefix = moduleName ? `/${moduleName}` : ''
  const destroyGuard = withPolicy
    ? `    await this.authorize('delete', [${singular}, ${variableName}])\n`
    : ''
  return `import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { ${singular} } from '../../Models/${singular}.js'
import { ${singular}Resource, type ${singular}ResourceData } from '../Resources/${singular}Resource.js'
import { ${singular}IdParamSchema, ${singular}PayloadSchema, List${collection}QuerySchema } from '../Validators/${singular}Validator.js'

type ${collection}IndexProps = PaginatedPageProps<${singular}ResourceData>

export default class ${singular}Controller extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(List${collection}QuerySchema)
    const result = await ${singular}.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/${routeName}' })

    return this.inertia(${pagesBase}.Index, {
      data: result.data.map((${variableName}) => new ${singular}Resource(${variableName}).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies ${collection}IndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)

    return this.inertia(${pagesBase}.Show, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(${pagesBase}.New, {})
  }

  async store(): Promise<Response> {
${authGuard}${createGuard}    const data = await this.validateBody(${singular}PayloadSchema)
    const ${variableName} = await ${singular}.create(data)
    return this.redirect('${redirectPrefix}/${routeName}/' + ${variableName}?.id)
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
    return this.inertia(${pagesBase}.Edit, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
      errors: {},
    })
  }

  async update(): Promise<Response> {
${authGuard}    const { id } = this.validateParams(${singular}IdParamSchema)
${updateGuard}    const data = await this.validateBody(${singular}PayloadSchema)
    await ${singular}.update({ id }, data)
    return this.redirect('${redirectPrefix}/${routeName}/' + id)
  }

  async destroy(): Promise<Response> {
${authGuard}    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
${destroyGuard}    await ${singular}.delete({ id: ${variableName}.id })
    return this.redirect('${redirectPrefix}/${routeName}')
  }
}
`
}

function generateIndexPage(
  singular: string,
  collection: string,
  routeName: string,
  variableName: string,
  fields: FieldDefinition[],
  appPrefix: string,
): string {
  // A json column is an object, which React cannot render as a child — and it
  // would make a poor list heading anyway. Skip to the next usable field.
  const displayFields = fields.filter((f) => f.type !== 'json')
  const titleField = displayFields[0]?.name ?? 'id'
  const summaryField = displayFields.length > 1 ? displayFields[1]?.name : null

  return `import { Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { ${singular}ResourceData } from '@/${appPrefix}app/Http/Resources/${singular}Resource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<${singular}ResourceData> {}

export default function ${collection}Index({ data, pagination }: Props) {
  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
        <div className="flex items-center justify-between">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            ${collection}
          </h1>
          <Link href={route('${routeName}.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">New ${singular}</Link>
        </div>
        <div className="space-y-4">
          {data.map((${variableName}) => (
            <article key={${variableName}.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
              <Link href={route('${routeName}.show', { id: ${variableName}.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">{${variableName}.${titleField}}</Link>
${summaryField ? `              <p className="mt-2 text-sm text-g-text-2">{${variableName}.${summaryField} ?? ''}</p>` : ''}
            </article>
          ))}
        </div>
        {pagination?.links?.pages && (
          <nav className="flex gap-2 font-mono text-sm">
            {pagination.links.pages.map((page) => (
              <Link key={page.page} href={page.url ?? '#'} className="rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading">
                {page.page}
              </Link>
            ))}
          </nav>
        )}
      </div>
    </main>
  )
}
`
}

function generateShowPage(
  singular: string,
  routeName: string,
  variableName: string,
  fields: FieldDefinition[],
  appPrefix: string,
): string {
  const fieldRenders = fields.map((f) => {
    if (f.type === 'boolean') {
      return `        <p><strong>${f.name}:</strong> {${variableName}.${f.name} ? 'Yes' : 'No'}</p>`
    }
    if (f.type === 'json') {
      // An object is not renderable as a React child.
      return `        <p><strong>${f.name}:</strong> {JSON.stringify(${variableName}.${f.name})}</p>`
    }
    return `        <p><strong>${f.name}:</strong> {${variableName}.${f.name}${f.nullable ? " ?? ''" : ''}}</p>`
  }).join('\n')

  return `import { Link } from '@inertiajs/react'
import type { ${singular}ResourceData } from '@/${appPrefix}app/Http/Resources/${singular}Resource'
import { route } from '@/.guren/routes.gen'

interface Props {
  ${variableName}: ${singular}ResourceData
}

export default function ${singular}Show({ ${variableName} }: Props) {
  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
        <Link href={route('${routeName}.index')} className="text-sm text-g-accent-text transition hover:underline">Back</Link>
${fieldRenders}
        <div className="flex items-center gap-4">
          <Link href={route('${routeName}.edit', { id: ${variableName}.id })} className="text-g-accent-text transition hover:underline">Edit</Link>
          <Link
            href={route('${routeName}.destroy', { id: ${variableName}.id })}
            method="delete"
            as="button"
            onBefore={() => window.confirm('Delete this ${variableName}?')}
            className="rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint"
          >
            Delete
          </Link>
        </div>
      </div>
    </main>
  )
}
`
}

function generateNewPage(
  singular: string,
  routeName: string,
  fields: FieldDefinition[],
): string {
  const defaults = fields.map((f) => `${f.name}: ${emptyFormValue(f)}`).join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')
  const state = generateFormState(fields, 'form')

  return `${state.imports}import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = RouteBody<ApiRoutes, '${routeName}.store'>

export default function New${singular}() {
  const form = useForm<${singular}FormData>({ ${defaults} })
${state.hooks}  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.post(route('${routeName}.store')) }}>
${formFields}
          <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">Create</button>
        </form>
      </div>
    </main>
  )
}
`
}

function generateEditPage(
  singular: string,
  routeName: string,
  variableName: string,
  fields: FieldDefinition[],
): string {
  const defaults = fields
    .map((f) => `${f.name}: ${withEmptyFallback(f, `${variableName}.${f.name}`)}`)
    .join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')
  const state = generateFormState(fields, 'form')

  return `${state.imports}import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody, RouteErrors } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = RouteBody<ApiRoutes, '${routeName}.store'>

interface Props {
  ${variableName}: ${singular}FormData & { id: number }
  errors?: RouteErrors<${singular}FormData> & { message?: string }
}

export default function Edit${singular}({ ${variableName} }: Props) {
  const form = useForm<${singular}FormData>({ ${defaults} })
${state.hooks}  return (
    <main className="min-h-screen bg-g-page font-sans text-g-text">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.put(route('${routeName}.update', { id: ${variableName}.id })) }}>
${formFields}
          <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">Save</button>
        </form>
      </div>
    </main>
  )
}
`
}

const FORM_INPUT_CLASS =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

function generateFormField(field: FieldDefinition, formVar: string): string {
  const value = formValue(field, formVar)
  if (field.type === 'boolean') {
    return `          <label className="flex items-center gap-2">
            <input type="checkbox" checked={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.checked)} className="h-4 w-4 rounded accent-g-accent" />
            ${field.name}
          </label>`
  }
  if (field.type === 'text') {
    return `          <textarea value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="${FORM_INPUT_CLASS}" />`
  }
  if (field.type === 'number') {
    return `          <input type="number" value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', Number(event.target.value))} placeholder="${field.name}" className="${FORM_INPUT_CLASS}" />`
  }
  if (field.type === 'date') {
    // The value arrives as an ISO timestamp but `type="date"` only renders a
    // bare `YYYY-MM-DD`, and shows nothing at all for anything longer.
    return `          <input type="date" value={${value}.slice(0, 10)} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} className="${FORM_INPUT_CLASS}" />`
  }
  if (field.type === 'json') {
    // Uncontrolled: a controlled textarea driven by the parsed object would
    // reject every keystroke that leaves the JSON temporarily invalid. The
    // flag is what keeps that from being silent — without it, submitting
    // half-typed JSON would quietly send the last value that parsed.
    return `          <textarea
            defaultValue={jsonText.${field.name}}
            onChange={(event) => {
              try {
                ${formVar}.setData('${field.name}', JSON.parse(event.target.value))
                setJsonErrors((prev) => ({ ...prev, ${field.name}: false }))
              } catch {
                setJsonErrors((prev) => ({ ...prev, ${field.name}: true }))
              }
            }}
            placeholder="${field.name}"
            className="${FORM_INPUT_CLASS} font-mono text-sm"
          />
          {jsonErrors.${field.name} && (
            <p className="text-sm text-g-danger">${field.name} is not valid JSON — fix it or the last valid value is submitted.</p>
          )}`
  }
  return `          <input value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="${FORM_INPUT_CLASS}" />`
}

/**
 * The hooks a page's JSON fields need, and the import that comes with them.
 *
 * Both are keyed by field name in one record rather than declared per field:
 * two fields whose names differ only in punctuation would otherwise generate
 * the same identifier, and `jsonText` is seeded once so an Edit page is not
 * re-serializing its record on every keystroke.
 */
function generateFormState(fields: FieldDefinition[], formVar: string): { imports: string; hooks: string } {
  const jsonFields = fields.filter((f) => f.type === 'json')
  if (jsonFields.length === 0) return { imports: '', hooks: '' }

  const initial = jsonFields
    .map((f) => `${f.name}: JSON.stringify(${formValue(f, formVar)}, null, 2)`)
    .join(', ')

  return {
    imports: "import { useState } from 'react'\n",
    hooks: `  const [jsonText] = useState(() => ({ ${initial} }))\n`
      + '  const [jsonErrors, setJsonErrors] = useState<Record<string, boolean>>({})\n',
  }
}
