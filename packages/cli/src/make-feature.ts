import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions, pascalCase, camelCase, kebabCase, pagesAccessor, safeModuleName } from './utils'
import { pluralize } from './inflect'
import { makeModel } from './make-model'
import { makePolicy } from './make-policy'
import { makeTest } from './make-test'
import { makeValidator } from './make-validator'
import { parseFieldsString, type FieldDefinition, type FieldType } from './fields'
import { schemaPathFor } from './schema-parser'

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
  const writerOptions: WriterOptions = { force: Boolean(options.force), root: options.root }

  // `--module <name>` moves app/ output under modules/<name>/ (handled by
  // scaffoldFile for makeModel/makePolicy/makeTest below), but pages are
  // NOT colocated per RFC 0002's initial scope — they stay under the
  // top-level resources/js/pages/, namespaced by the module name instead
  // (resources/js/pages/<module>/<routeName>/...).
  const moduleName = options.root ? safeModuleName(options.root) : undefined
  const appPrefix = moduleName ? `modules/${moduleName}/` : ''
  const pagePrefix = moduleName ? `${moduleName}/` : ''

  // Composed rather than emitted inline — the same way makeModel/makePolicy/
  // makeTest are below — so the schema names the generated controller imports
  // and the ones `make:validator` writes cannot drift apart.
  const validatorPath = await makeValidator(singular, { ...writerOptions, fields })

  const created = await writeFilesSafe([
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

  const authSuffix = withAuth ? `.middleware('auth')` : ''
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
  if (withAuth) {
    consola.info(`     router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))`)
  }
  consola.info(`     router.group('/${routeName}', (${routeVar}) => {`)
  consola.info(`       ${routeVar}.get('/', [${singular}Controller, 'index']).name('${routeName}.index')`)
  consola.info(`       ${routeVar}.get('/create', [${singular}Controller, 'create']).name('${routeName}.create')`)
  consola.info(`       ${routeVar}.get('/:id', [${singular}Controller, 'show']).name('${routeName}.show')`)
  consola.info(`       ${routeVar}.get('/:id/edit', [${singular}Controller, 'edit']).name('${routeName}.edit')`)
  consola.info(`       ${routeVar}.post('/', { name: '${routeName}.store', body: ${singular}PayloadSchema }, [${singular}Controller, 'store'])${authSuffix}`)
  consola.info(`       ${routeVar}.put('/:id', { name: '${routeName}.update', body: ${singular}PayloadSchema }, [${singular}Controller, 'update'])${authSuffix}`)
  consola.info(`       ${routeVar}.delete('/:id', { name: '${routeName}.destroy' }, [${singular}Controller, 'destroy'])${authSuffix}`)
  consola.info(`     })`)
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
 * A `date` column serializes to the ISO string `tsFieldType` declares, so it is
 * converted rather than cast. It goes through `new Date()` because the driver
 * decides what it hands back: Postgres `timestamp` yields a `Date`, but SQLite
 * — the default scaffold — stores dates in a `text` column and yields a string.
 */
function resourceFieldExpression(field: FieldDefinition): string {
  const access = `this.resource.${field.name}`
  if (field.type === 'date') {
    const iso = `new Date(${access} as string | number | Date).toISOString()`
    return field.nullable ? `${access} == null ? null : ${iso}` : iso
  }
  return field.nullable
    ? `(${access} as ${tsFieldType(field)}) ?? null`
    : `${access} as ${tsFieldType(field)}`
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
  const dataFields = [
    '  id: number',
    ...fields.map((f) => `  ${f.name}: ${tsFieldType(f)}`),
  ].join('\n')

  const toArrayFields = [
    '      id: this.resource.id as number,',
    ...fields.map((f) => `      ${f.name}: ${resourceFieldExpression(f)},`),
  ].join('\n')

  return `import { Resource } from '@guren/core'
import type { ${singular}Record } from '../../Models/${singular}.js'

export interface ${singular}ResourceData extends Record<string, unknown> {
${dataFields}
}

export class ${singular}Resource extends Resource<${singular}Record> {
  toArray(): ${singular}ResourceData {
    return {
${toArrayFields}
    }
  }

  override toJSON(): ${singular}ResourceData {
    return super.toJSON() as ${singular}ResourceData
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
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">${collection}</h1>
        <Link href={route('${routeName}.create')} className="rounded bg-black px-4 py-2 text-white">New ${singular}</Link>
      </div>
      <div className="space-y-4">
        {data.map((${variableName}) => (
          <article key={${variableName}.id} className="rounded border p-4">
            <Link href={route('${routeName}.show', { id: ${variableName}.id })} className="text-xl font-medium">{${variableName}.${titleField}}</Link>
${summaryField ? `            <p className="mt-2 text-sm text-zinc-600">{${variableName}.${summaryField} ?? ''}</p>` : ''}
          </article>
        ))}
      </div>
      {pagination?.links?.pages && (
        <nav className="flex gap-2">
          {pagination.links.pages.map((page) => (
            <Link key={page.page} href={page.url ?? '#'} className="rounded border px-3 py-1">
              {page.page}
            </Link>
          ))}
        </nav>
      )}
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
      return `      <p><strong>${f.name}:</strong> {${variableName}.${f.name} ? 'Yes' : 'No'}</p>`
    }
    if (f.type === 'json') {
      // An object is not renderable as a React child.
      return `      <p><strong>${f.name}:</strong> {JSON.stringify(${variableName}.${f.name})}</p>`
    }
    return `      <p><strong>${f.name}:</strong> {${variableName}.${f.name}${f.nullable ? " ?? ''" : ''}}</p>`
  }).join('\n')

  return `import { Link } from '@inertiajs/react'
import type { ${singular}ResourceData } from '@/${appPrefix}app/Http/Resources/${singular}Resource'
import { route } from '@/.guren/routes.gen'

interface Props {
  ${variableName}: ${singular}ResourceData
}

export default function ${singular}Show({ ${variableName} }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('${routeName}.index')}>Back</Link>
${fieldRenders}
      <div className="flex gap-4">
        <Link href={route('${routeName}.edit', { id: ${variableName}.id })}>Edit</Link>
        <Link
          href={route('${routeName}.destroy', { id: ${variableName}.id })}
          method="delete"
          as="button"
          onBefore={() => window.confirm('Delete this ${variableName}?')}
          className="text-red-600"
        >
          Delete
        </Link>
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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.post(route('${routeName}.store')) }}>
${formFields}
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Create</button>
      </form>
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
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(submitEvent) => { submitEvent.preventDefault(); form.put(route('${routeName}.update', { id: ${variableName}.id })) }}>
${formFields}
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Save</button>
      </form>
    </main>
  )
}
`
}

function generateFormField(field: FieldDefinition, formVar: string): string {
  const value = formValue(field, formVar)
  if (field.type === 'boolean') {
    return `        <label className="flex items-center gap-2">
          <input type="checkbox" checked={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.checked)} />
          ${field.name}
        </label>`
  }
  if (field.type === 'text') {
    return `        <textarea value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'number') {
    return `        <input type="number" value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', Number(event.target.value))} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'date') {
    // The value arrives as an ISO timestamp but `type="date"` only renders a
    // bare `YYYY-MM-DD`, and shows nothing at all for anything longer.
    return `        <input type="date" value={${value}.slice(0, 10)} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'json') {
    // Uncontrolled: a controlled textarea driven by the parsed object would
    // reject every keystroke that leaves the JSON temporarily invalid. The
    // flag is what keeps that from being silent — without it, submitting
    // half-typed JSON would quietly send the last value that parsed.
    return `        <textarea
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
          className="w-full rounded border px-3 py-2 font-mono text-sm"
        />
        {jsonErrors.${field.name} && (
          <p className="text-sm text-red-600">${field.name} is not valid JSON — fix it or the last valid value is submitted.</p>
        )}`
  }
  return `        <input value={${value}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
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
