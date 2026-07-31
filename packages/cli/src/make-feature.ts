import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions, pascalCase, kebabCase, pagesAccessor, safeModuleName } from './utils'
import { makeModel } from './make-model'
import { makePolicy } from './make-policy'
import { makeTest } from './make-test'

export const FIELD_TYPES = ['string', 'number', 'boolean', 'text', 'date', 'json'] as const

export type FieldType = (typeof FIELD_TYPES)[number]

export interface FieldDefinition {
  name: string
  type: FieldType
  nullable?: boolean
}

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

const DEFAULT_FIELDS: FieldDefinition[] = [
  { name: 'title', type: 'string' },
  { name: 'body', type: 'text', nullable: true },
]

export function parseFieldsString(fieldsStr: string): FieldDefinition[] {
  if (!fieldsStr.trim()) return DEFAULT_FIELDS

  return fieldsStr.split(',').map((field) => {
    const parts = field.trim().split(':')
    const name = parts[0]?.trim()
    const rawType = parts[1]?.trim() ?? 'string'
    const nullable = rawType.endsWith('?')
    const type = nullable ? rawType.slice(0, -1) : rawType

    if (!name) throw new Error(`Invalid field definition: "${field}"`)

    // The name is interpolated raw into interfaces, object literals, and
    // property access, so anything that is not an identifier would emit
    // generated code that does not parse.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) {
      throw new Error(`Invalid field name "${name}". Field names must be valid JavaScript identifiers.`)
    }

    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid field type "${type}" for field "${name}". Valid: ${FIELD_TYPES.join(', ')}`)
    }

    return { name, type: type as FieldType, nullable }
  })
}

export async function makeFeature(name: string, options: MakeFeatureOptions = {}): Promise<string[]> {
  const fields = parseFieldsString(options.fields ?? '')
  const singular = pascalCase(name)
  const collection = pluralize(singular)
  const routeName = kebabCase(collection)
  const routeVar = routeName.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
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

  const created = await writeFilesSafe([
    {
      path: `${appPrefix}app/Http/Validators/${singular}Validator.ts`,
      contents: generateValidator(singular, collection, fields),
    },
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
      contents: generateEditPage(singular, routeName, variableName, fields, appPrefix),
    },
  ], writerOptions)

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
  const schemaPath = moduleName ? `modules/${moduleName}/db/schema.ts` : 'db/schema.ts'
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

// Keyed by FieldType rather than string so a new field type fails to compile
// until every mapping below covers it — a silent `?? 'string'` fallback is how
// a type ends up generating code for the wrong column shape.
const ZOD_SCHEMAS: Record<FieldType, string> = {
  string: 'z.string().trim().min(1)',
  text: 'z.string().trim().min(1)',
  number: 'z.coerce.number()',
  boolean: 'z.boolean()',
  date: 'z.coerce.date()',
  json: 'z.record(z.string(), z.unknown())',
}

const TS_TYPES: Record<FieldType, string> = {
  string: 'string',
  text: 'string',
  number: 'number',
  boolean: 'boolean',
  date: 'string',
  json: 'Record<string, unknown>',
}

function zodFieldType(field: FieldDefinition): string {
  const schema = ZOD_SCHEMAS[field.type]
  return field.nullable ? `${schema}.nullable().optional()` : schema
}

function tsFieldType(field: FieldDefinition): string {
  const base = TS_TYPES[field.type]
  return field.nullable ? `${base} | null` : base
}

/**
 * Expression that reads a column off the model record and returns it in the
 * JSON-serializable shape `tsFieldType()` promises.
 *
 * Date columns are the only ones that need real work: the record type is a
 * `Date` on postgres/mysql/sqlite timestamp columns, so it has to be turned
 * into an ISO string explicitly. The `string | number | Date` cast keeps the
 * expression valid whichever representation the column was hand-edited to.
 */
function resourceValueExpression(field: FieldDefinition): string {
  const source = `this.resource.${field.name}`

  if (field.type === 'date') {
    const iso = `new Date(${source} as string | number | Date).toISOString()`
    return field.nullable ? `${source} == null ? null : ${iso}` : iso
  }

  return field.nullable
    ? `(${source} as ${tsFieldType(field)}) ?? null`
    : `${source} as ${tsFieldType(field)}`
}

/**
 * Expression that renders a `ResourceData` field as page text. Booleans read
 * better as Yes/No, and objects are not valid `ReactNode`s.
 */
function resourceDisplayExpression(field: FieldDefinition, variableName: string): string {
  const access = `${variableName}.${field.name}`

  if (field.type === 'boolean') return `${access} ? 'Yes' : 'No'`
  if (field.type === 'json') return `JSON.stringify(${access})`
  return field.nullable ? `${access} ?? ''` : access
}

/**
 * The form data type for the New/Edit pages.
 *
 * It is the route's request body type, except that `json` fields are edited as
 * raw JSON text: an object value fails Inertia's `FormDataType` constraint
 * (`unknown` is not `FormDataConvertible`) and cannot back a textarea, so the
 * form holds the source text and `submitStatements()` parses it on submit.
 */
function formDataType(routeName: string, fields: FieldDefinition[]): string {
  const body = `ApiRoutes['${routeName}.store']['body']`
  const jsonFields = fields.filter((f) => f.type === 'json')
  if (jsonFields.length === 0) return body

  const omitted = jsonFields.map((f) => `'${f.name}'`).join(' | ')
  const overrides = jsonFields.map((f) => `${f.name}: string`).join('; ')
  return `Omit<${body}, ${omitted}> & { ${overrides} }`
}

/**
 * The `onSubmit` attribute for the New/Edit form.
 *
 * With no json fields this is the one-liner it has always been. json fields
 * hold source text that has to become an object before it is sent, and a typo
 * in that text must surface as a form error rather than an exception thrown out
 * of the handler — so those pages get a block body that parses first and
 * installs the transform only once every field parsed.
 */
function submitHandler(fields: FieldDefinition[], submitCall: string): string {
  const jsonFields = fields.filter((f) => f.type === 'json')

  if (jsonFields.length === 0) {
    return `onSubmit={(event) => { event.preventDefault(); ${submitCall} }}`
  }

  const parses = jsonFields.map((f) => {
    const parse = f.nullable
      ? `form.data.${f.name} ? JSON.parse(form.data.${f.name}) : null`
      : `JSON.parse(form.data.${f.name})`
    return `        let ${f.name}: unknown
        try {
          ${f.name} = ${parse}
        } catch {
          form.setError('${f.name}', 'Enter valid JSON.')
          return
        }`
  }).join('\n')

  const overrides = jsonFields.map((f) => f.name).join(', ')

  return `onSubmit={(event) => {
        event.preventDefault()
${parses}
        form.transform((data) => ({ ...data, ${overrides} }))
        ${submitCall}
      }}`
}

/** Module-level helpers the generated form fields call. */
function formPageHelpers(fields: FieldDefinition[]): string {
  if (!fields.some((f) => f.type === 'date')) return ''

  return `
function toDateInputValue(value: Date | string | null | undefined): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
`
}

function generateValidator(singular: string, collection: string, fields: FieldDefinition[]): string {
  const fieldSchemas = fields.map((f) => `  ${f.name}: ${zodFieldType(f)},`).join('\n')
  return `import { z } from 'zod'

export const ${singular}IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const List${collection}QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const ${singular}PayloadSchema = z.object({
${fieldSchemas}
})

export type ${singular}Payload = z.infer<typeof ${singular}PayloadSchema>
`
}

function generateResource(singular: string, fields: FieldDefinition[]): string {
  const dataFields = [
    '  id: number',
    ...fields.map((f) => `  ${f.name}: ${tsFieldType(f)}`),
  ].join('\n')

  const toArrayFields = [
    '      id: this.resource.id as number,',
    ...fields.map((f) => `      ${f.name}: ${resourceValueExpression(f)},`),
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
  const titleField = fields[0] ? resourceDisplayExpression(fields[0], variableName) : `${variableName}.id`
  const summaryField = fields[1] ? resourceDisplayExpression(fields[1], variableName) : null

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
            <Link href={route('${routeName}.show', { id: ${variableName}.id })} className="text-xl font-medium">{${titleField}}</Link>
${summaryField ? `            <p className="mt-2 text-sm text-zinc-600">{${summaryField}}</p>` : ''}
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
  const fieldRenders = fields
    .map((f) => `      <p><strong>${f.name}:</strong> {${resourceDisplayExpression(f, variableName)}}</p>`)
    .join('\n')

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
  const defaults = fields.map((f) => `${f.name}: ${newPageDefault(f)}`).join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')
  const onSubmit = submitHandler(fields, `form.post(route('${routeName}.store'))`)

  return `import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = ${formDataType(routeName, fields)}
${formPageHelpers(fields)}
export default function New${singular}() {
  const form = useForm<${singular}FormData>({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" ${onSubmit}>
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
  appPrefix: string,
): string {
  const defaults = fields.map((f) => `${f.name}: ${editPageDefault(f, variableName)}`).join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')
  const onSubmit = submitHandler(fields, `form.put(route('${routeName}.update', { id: ${variableName}.id }))`)

  return `import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import type { ${singular}ResourceData } from '@/${appPrefix}app/Http/Resources/${singular}Resource'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = ${formDataType(routeName, fields)}

interface Props {
  ${variableName}: ${singular}ResourceData
  errors?: RouteErrors<${singular}FormData> & { message?: string }
}
${formPageHelpers(fields)}
export default function Edit${singular}({ ${variableName} }: Props) {
  const form = useForm<${singular}FormData>({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" ${onSubmit}>
${formFields}
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Save</button>
      </form>
    </main>
  )
}
`
}

/** Initial form value for a field on the New page. */
function newPageDefault(field: FieldDefinition): string {
  switch (field.type) {
    case 'boolean':
      return 'false'
    case 'number':
      return '0'
    case 'date':
      // The form data type is the route body type, so this is a real `Date`
      // — Inertia serializes it to an ISO string that `z.coerce.date()` reads.
      return field.nullable ? 'null' : 'new Date()'
    case 'json':
      return field.nullable ? "''" : "'{}'"
    default:
      return "''"
  }
}

/** Initial form value for a field on the Edit page, read off the resource props. */
function editPageDefault(field: FieldDefinition, variableName: string): string {
  const access = `${variableName}.${field.name}`

  switch (field.type) {
    case 'date':
      // `ResourceData` carries dates as ISO strings; the form wants a `Date`.
      return field.nullable ? `${access} ? new Date(${access}) : null` : `new Date(${access})`
    case 'json':
      return field.nullable ? `${access} ? JSON.stringify(${access}) : ''` : `JSON.stringify(${access})`
    case 'boolean':
      return field.nullable ? `${access} ?? false` : access
    case 'number':
      return field.nullable ? `${access} ?? 0` : access
    default:
      return field.nullable ? `${access} ?? ''` : access
  }
}

function generateFormField(field: FieldDefinition, formVar: string): string {
  // Nullable fields are typed `T | null | undefined` — coalesce for controlled inputs.
  const stringValue = field.nullable ? `${formVar}.data.${field.name} ?? ''` : `${formVar}.data.${field.name}`
  if (field.type === 'boolean') {
    const checkedValue = field.nullable ? `${formVar}.data.${field.name} ?? false` : `${formVar}.data.${field.name}`
    return `        <label className="flex items-center gap-2">
          <input type="checkbox" checked={${checkedValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.checked)} />
          ${field.name}
        </label>`
  }
  if (field.type === 'text') {
    return `        <textarea value={${stringValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'number') {
    const numberValue = field.nullable ? `${formVar}.data.${field.name} ?? 0` : `${formVar}.data.${field.name}`
    return `        <input type="number" value={${numberValue}} onChange={(event) => ${formVar}.setData('${field.name}', Number(event.target.value))} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'date') {
    // A cleared required input would set an invalid Date, which serializes to
    // null and which `z.coerce.date()` then reads as the epoch — `required`
    // keeps the browser from submitting that instead of storing 1970-01-01.
    const onChange = field.nullable
      ? `event.target.value ? new Date(event.target.value) : null`
      : `new Date(event.target.value)`
    const required = field.nullable ? '' : ' required'
    return `        <input type="date"${required} value={toDateInputValue(${formVar}.data.${field.name})} onChange={(event) => ${formVar}.setData('${field.name}', ${onChange})} className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'json') {
    // The form holds JSON source text; onSubmit parses it back into an object.
    return `        <textarea value={${stringValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name} (JSON)" className="w-full rounded border px-3 py-2 font-mono text-sm" />`
  }
  return `        <input value={${stringValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
}

function pluralize(name: string): string {
  if (/[^aeiou]y$/iu.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/iu.test(name)) return `${name}es`
  return `${name}s`
}
