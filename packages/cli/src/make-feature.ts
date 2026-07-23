import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions, pascalCase, kebabCase } from './utils'
import { makeModel } from './make-model'
import { makePolicy } from './make-policy'
import { makeTest } from './make-test'

export interface FieldDefinition {
  name: string
  type: 'string' | 'number' | 'boolean' | 'text' | 'date' | 'json'
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

    const validTypes = ['string', 'number', 'boolean', 'text', 'date', 'json']
    if (!validTypes.includes(type)) {
      throw new Error(`Invalid field type "${type}" for field "${name}". Valid: ${validTypes.join(', ')}`)
    }

    return { name, type: type as FieldDefinition['type'], nullable }
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
  const moduleName = options.root ? kebabCase(options.root) : undefined
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
      contents: generateController(singular, collection, routeName, routeVar, variableName, fields, withAuth, withPolicy),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/Index.tsx`,
      contents: generateIndexPage(singular, collection, routeName, variableName, fields),
    },
    {
      path: `resources/js/pages/${pagePrefix}${routeName}/Show.tsx`,
      contents: generateShowPage(singular, routeName, variableName, fields),
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
  consola.info('')
  consola.info('Next steps:')
  consola.info(`  1. Add table definition to db/schema.ts`)
  consola.info(`  2. Register routes in routes/web.ts with body schemas:`)
  consola.info(`     import ${singular}Controller from '../app/Http/Controllers/${singular}Controller.js'`)
  consola.info(`     import { ${singular}PayloadSchema } from '../app/Http/Validators/${singular}Validator.js'`)
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
  consola.info(`     })`)
  consola.info(`  3. Run: bunx guren db:migrate`)
  consola.info(`  4. Run: bunx guren codegen`)
  if (withPolicy) {
    consola.info(`  5. Register the policy in src/app.ts (inside the boot callback):`)
    consola.info(`     import { getGate } from '@guren/core'`)
    consola.info(`     import { ${singular} } from '../app/Models/${singular}.js'`)
    consola.info(`     import { ${singular}Policy } from '../app/Policies/${singular}Policy.js'`)
    consola.info(`     getGate().policy(${singular}, ${singular}Policy)`)
  }
  if (withAuth) {
    consola.info('')
    consola.info(`  Note: store/update call this.auth.userOrFail() — unauthenticated requests get 401.`)
    consola.info(`  Use --public to scaffold without authentication checks.`)
  }

  return created
}

// --- Template generators ---

function drizzleColumnType(field: FieldDefinition): string {
  const map: Record<string, string> = {
    string: 'text',
    text: 'text',
    number: 'integer',
    boolean: 'boolean',
    date: 'timestamp',
    json: 'jsonb',
  }
  const col = map[field.type] ?? 'text'
  const nullable = field.nullable ? '' : '.notNull()'
  return `${field.name}: ${col}('${field.name}')${nullable}`
}

function zodFieldType(field: FieldDefinition): string {
  const map: Record<string, string> = {
    string: 'z.string().trim().min(1)',
    text: 'z.string().trim().min(1)',
    number: 'z.coerce.number()',
    boolean: 'z.boolean()',
    date: 'z.coerce.date()',
    json: 'z.record(z.unknown())',
  }
  let schema = map[field.type] ?? 'z.string()'
  if (field.nullable) schema += '.nullable().optional()'
  return schema
}

function tsFieldType(field: FieldDefinition): string {
  const map: Record<string, string> = {
    string: 'string',
    text: 'string',
    number: 'number',
    boolean: 'boolean',
    date: 'string',
    json: 'Record<string, unknown>',
  }
  const base = map[field.type] ?? 'string'
  return field.nullable ? `${base} | null` : base
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
    ...fields.map((f) => {
      if (f.nullable) {
        return `      ${f.name}: (this.resource.${f.name} as ${tsFieldType(f)}) ?? null,`
      }
      return `      ${f.name}: this.resource.${f.name} as ${tsFieldType(f)},`
    }),
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
): string {
  const authGuard = withAuth ? '    await this.auth.userOrFail()\n' : ''
  const createGuard = withPolicy ? `    await this.authorize('create', ${singular})\n` : ''
  const updateGuard = withPolicy
    ? `    await this.authorize('update', [${singular}, await ${singular}.findOrFail(id)])\n`
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

    return this.inertia(pages.${routeVar}.Index, {
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

    return this.inertia(pages.${routeVar}.Show, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.${routeVar}.New, {})
  }

  async store(): Promise<Response> {
${authGuard}${createGuard}    const data = await this.validateBody(${singular}PayloadSchema)
    const ${variableName} = await ${singular}.create(data)
    return this.redirect('/${routeName}/' + ${variableName}?.id)
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
    return this.inertia(pages.${routeVar}.Edit, {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
      errors: {},
    })
  }

  async update(): Promise<Response> {
${authGuard}    const { id } = this.validateParams(${singular}IdParamSchema)
${updateGuard}    const data = await this.validateBody(${singular}PayloadSchema)
    await ${singular}.update({ id }, data)
    return this.redirect('/${routeName}/' + id)
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
): string {
  const titleField = fields[0]?.name ?? 'id'
  const summaryField = fields.length > 1 ? fields[1]?.name : null

  return `import { Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { ${singular}ResourceData } from '@/app/Http/Resources/${singular}Resource'
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
): string {
  const fieldRenders = fields.map((f) => {
    if (f.type === 'boolean') {
      return `      <p><strong>${f.name}:</strong> {${variableName}.${f.name} ? 'Yes' : 'No'}</p>`
    }
    return `      <p><strong>${f.name}:</strong> {${variableName}.${f.name}${f.nullable ? " ?? ''" : ''}}</p>`
  }).join('\n')

  return `import { Link } from '@inertiajs/react'
import type { ${singular}ResourceData } from '@/app/Http/Resources/${singular}Resource'
import { route } from '@/.guren/routes.gen'

interface Props {
  ${variableName}: ${singular}ResourceData
}

export default function ${singular}Show({ ${variableName} }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('${routeName}.index')}>Back</Link>
${fieldRenders}
      <Link href={route('${routeName}.edit', { id: ${variableName}.id })}>Edit</Link>
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
  const defaults = fields.map((f) => {
    const defaultVal = f.type === 'boolean' ? 'false' : f.type === 'number' ? '0' : "''"
    return `${f.name}: ${defaultVal}`
  }).join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')

  return `import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = ApiRoutes['${routeName}.store']['body']

export default function New${singular}() {
  const form = useForm<${singular}FormData>({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.post(route('${routeName}.store')) }}>
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
  const defaults = fields.map((f) => {
    const defaultVal = f.nullable ? ` ?? ${f.type === 'boolean' ? 'false' : f.type === 'number' ? '0' : "''"}` : ''
    return `${f.name}: ${variableName}.${f.name}${defaultVal}`
  }).join(', ')

  const formFields = fields.map((f) => generateFormField(f, 'form')).join('\n')

  return `import { useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteErrors } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type ${singular}FormData = ApiRoutes['${routeName}.store']['body']

interface Props {
  ${variableName}: ${singular}FormData & { id: number }
  errors?: RouteErrors<${singular}FormData> & { message?: string }
}

export default function Edit${singular}({ ${variableName} }: Props) {
  const form = useForm<${singular}FormData>({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.put(route('${routeName}.update', { id: ${variableName}.id })) }}>
${formFields}
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Save</button>
      </form>
    </main>
  )
}
`
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
    return `        <input type="date" value={${stringValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} className="w-full rounded border px-3 py-2" />`
  }
  return `        <input value={${stringValue}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
}

function pluralize(name: string): string {
  if (/[^aeiou]y$/iu.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/iu.test(name)) return `${name}es`
  return `${name}s`
}
