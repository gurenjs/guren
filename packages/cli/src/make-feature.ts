import { consola } from 'consola'
import { writeFilesSafe, type WriterOptions, pascalCase, kebabCase } from './utils'
import { makeModel } from './make-model'
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
  const writerOptions: WriterOptions = { force: Boolean(options.force) }

  const created = await writeFilesSafe([
    {
      path: `app/Http/Validators/${singular}Validator.ts`,
      contents: generateValidator(singular, collection, fields),
    },
    {
      path: `app/Http/Resources/${singular}Resource.ts`,
      contents: generateResource(singular, fields),
    },
    {
      path: `app/Http/Controllers/${singular}Controller.ts`,
      contents: generateController(singular, collection, routeName, routeVar, variableName, fields),
    },
    {
      path: `resources/js/pages/${routeName}/Index.tsx`,
      contents: generateIndexPage(singular, collection, routeName, variableName, fields),
    },
    {
      path: `resources/js/pages/${routeName}/Show.tsx`,
      contents: generateShowPage(singular, routeName, variableName, fields),
    },
    {
      path: `resources/js/pages/${routeName}/New.tsx`,
      contents: generateNewPage(singular, routeName, fields),
    },
    {
      path: `resources/js/pages/${routeName}/Edit.tsx`,
      contents: generateEditPage(singular, routeName, variableName, fields),
    },
  ], writerOptions)

  // Create model
  const modelPath = await makeModel(singular, writerOptions)
  created.push(modelPath)

  // Optionally create test
  if (options.withTest) {
    try {
      const testPath = await makeTest(singular, writerOptions)
      created.push(testPath)
    } catch {
      // Ignore if test creation fails
    }
  }

  for (const file of created) {
    consola.success(`Created ${file}`)
  }

  consola.info('')
  consola.info('Next steps:')
  consola.info(`  1. Add table definition to db/schema.ts`)
  consola.info(`  2. Register routes in routes/web.ts`)
  consola.info(`  3. Run: bunx guren db:migrate`)
  consola.info(`  4. Run: bunx guren codegen`)

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
  _routeVar: string,
  variableName: string,
  fields: FieldDefinition[],
): string {
  const fieldNames = fields.map((f) => `'${f.name}'`).join(' | ')
  return `import { Controller, paginate, type PaginatedPageProps, type ValidationErrors } from '@guren/core'
import { ${singular} } from '../../Models/${singular}.js'
import { ${singular}Resource, type ${singular}ResourceData } from '../Resources/${singular}Resource.js'
import { ${singular}IdParamSchema, ${singular}PayloadSchema, List${collection}QuerySchema } from '../Validators/${singular}Validator.js'

type ${collection}IndexProps = PaginatedPageProps<${singular}ResourceData>
type ${singular}FormErrors = ValidationErrors<${fieldNames}>

export default class ${singular}Controller extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(List${collection}QuerySchema)
    const result = await ${singular}.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/${routeName}' })

    return this.inertia('${routeName}/Index', {
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

    return this.inertia('${routeName}/Show', {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia('${routeName}/New', {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(${singular}PayloadSchema)
    const ${variableName} = await ${singular}.create(data)
    return this.redirect('/${routeName}/' + ${variableName}?.id)
  }

  async edit(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const ${variableName} = await ${singular}.findOrFail(id)
    return this.inertia('${routeName}/Edit', {
      ${variableName}: new ${singular}Resource(${variableName}).toJSON(),
      errors: {} as ${singular}FormErrors,
    })
  }

  async update(): Promise<Response> {
    const { id } = this.validateParams(${singular}IdParamSchema)
    const data = await this.validateBody(${singular}PayloadSchema)
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

export default function ${collection}Index({ data, pagination }: any) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">${collection}</h1>
        <Link href="/${routeName}/new" className="rounded bg-black px-4 py-2 text-white">New ${singular}</Link>
      </div>
      <div className="space-y-4">
        {data.map((${variableName}: any) => (
          <article key={${variableName}.id} className="rounded border p-4">
            <Link href={'/${routeName}/' + ${variableName}.id} className="text-xl font-medium">{${variableName}.${titleField}}</Link>
${summaryField ? `            <p className="mt-2 text-sm text-zinc-600">{${variableName}.${summaryField} ?? ''}</p>` : ''}
          </article>
        ))}
      </div>
      {pagination?.links?.pages && (
        <nav className="flex gap-2">
          {pagination.links.pages.map((page: any) => (
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

export default function ${singular}Show({ ${variableName} }: any) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href="/${routeName}">Back</Link>
${fieldRenders}
      <Link href={'/${routeName}/' + ${variableName}.id + '/edit'}>Edit</Link>
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

export default function New${singular}() {
  const form = useForm({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.post('/${routeName}') }}>
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

export default function Edit${singular}({ ${variableName} }: any) {
  const form = useForm({ ${defaults} })
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); form.put('/${routeName}/' + ${variableName}.id) }}>
${formFields}
        <button type="submit" className="rounded bg-black px-4 py-2 text-white">Save</button>
      </form>
    </main>
  )
}
`
}

function generateFormField(field: FieldDefinition, formVar: string): string {
  if (field.type === 'boolean') {
    return `        <label className="flex items-center gap-2">
          <input type="checkbox" checked={${formVar}.data.${field.name}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.checked)} />
          ${field.name}
        </label>`
  }
  if (field.type === 'text') {
    return `        <textarea value={${formVar}.data.${field.name}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'number') {
    return `        <input type="number" value={${formVar}.data.${field.name}} onChange={(event) => ${formVar}.setData('${field.name}', Number(event.target.value))} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
  }
  if (field.type === 'date') {
    return `        <input type="date" value={${formVar}.data.${field.name}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} className="w-full rounded border px-3 py-2" />`
  }
  return `        <input value={${formVar}.data.${field.name}} onChange={(event) => ${formVar}.setData('${field.name}', event.target.value)} placeholder="${field.name}" className="w-full rounded border px-3 py-2" />`
}

function pluralize(name: string): string {
  if (/[^aeiou]y$/iu.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/iu.test(name)) return `${name}es`
  return `${name}s`
}
