import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  buildFormContracts,
  buildFormsContent,
  FORMS_MANIFEST_FILE,
  formIdentifier,
  generateFormTypes,
  planFormsManifest,
  readFieldContract,
} from '../src/forms-types'

const route = (name: string, body: unknown, method = 'POST', path = '/x') => ({ name, method, path, schemas: { body } })
const read = (schema: z.ZodType) => readFieldContract(schema as never, [], 'body.field')

describe('formIdentifier', () => {
  it('camel-cases the route name and appends Form', () => {
    expect(formIdentifier('posts.store')).toBe('postsStoreForm')
    expect(formIdentifier('forgot-password.store')).toBe('forgotPasswordStoreForm')
    expect(formIdentifier('admin.user_roles.update')).toBe('adminUserRolesUpdateForm')
  })

  it('prefixes a name that would start with a digit', () => {
    expect(formIdentifier('2fa.verify')).toBe('_2faVerifyForm')
  })
})

describe('readFieldContract', () => {
  it('reads requiredness and the constraints with an HTML counterpart', () => {
    expect(read(z.string().trim().min(1).max(120))).toEqual({ type: 'string', required: true, minLength: 1, maxLength: 120 })
    expect(read(z.coerce.number().int().min(0).max(10))).toEqual({ type: 'integer', required: true, minimum: 0, maximum: 10 })
    expect(read(z.boolean().optional())).toEqual({ type: 'boolean', required: false })
    expect(read(z.enum(['news', 'howto']))).toEqual({ type: 'string', required: true, enum: ['news', 'howto'] })
    expect(read(z.email())).toEqual({ type: 'string', required: true, format: 'email' })
  })

  it('folds nullable back into the inner type', () => {
    expect(read(z.coerce.number().nullable().optional())).toEqual({ type: 'number', required: false, nullable: true })
  })

  it('tells a Date-taking schema from a string-taking one', () => {
    expect(read(z.date())).toMatchObject({ format: 'date-time', value: 'Date' })
    expect(read(z.coerce.date())).toMatchObject({ format: 'date-time', value: 'string' })
    expect(read(z.iso.datetime())).toMatchObject({ format: 'date-time', value: 'string' })
  })

  it('takes no format from a pipe whose input stage is a plain string', () => {
    expect(read(z.string().trim().toLowerCase().pipe(z.email()))).toEqual({ type: 'string', required: true })
  })

  it('keeps a key the walker cannot render, with its requiredness', () => {
    expect(read(z.file())).toEqual({ type: 'unknown', required: true })
    expect(read(z.union([z.boolean(), z.string()]).optional())).toEqual({ type: 'unknown', required: false })
  })

  it('leaves out a pattern, which an HTML pattern would read differently', () => {
    expect(read(z.string().includes('x'))).toEqual({ type: 'string', required: true })
  })
})

describe('buildFormContracts', () => {
  it('writes one contract per named route an Inertia form submits to with an object body, sorted by name', () => {
    const contracts = buildFormContracts([
      route('posts.store', z.object({ title: z.string() })),
      route('posts.index', undefined, 'GET'),
      { method: 'POST', path: '/unnamed', schemas: { body: z.object({ a: z.string() }) } },
      route('comments.store', z.object({ body: z.string() })),
      route('raw.store', z.string()),
      route('posts.search', z.object({ q: z.string() }), 'QUERY'),
    ], [])
    expect(contracts.map((contract) => contract.identifier)).toEqual(['commentsStoreForm', 'postsStoreForm'])
  })

  it('fails on two route names that camel-case to one identifier, naming both', () => {
    const body = z.object({ a: z.string() })
    expect(() => buildFormContracts([route('posts.store', body), route('posts-store', body)], [])).toThrow(/"posts-store".*"posts\.store"|"posts\.store".*"posts-store"/u)
  })
})

describe('buildFormsContent', () => {
  it('types each contract against its ApiRoutes body', () => {
    const content = buildFormsContent(buildFormContracts([route('posts.update', z.object({ 'meta-title': z.string() }), 'PUT', '/posts/:id')], []))
    expect(content).toContain("import type { RouteFormContract } from '@guren/inertia-client/forms'")
    expect(content).toContain("export const postsUpdateForm: RouteFormContract<'posts.update', 'PUT', '/posts/:id', ApiRoutes['posts.update']['body']> = {")
    expect(content).toContain(`["meta-title"]: { type: 'string', required: true },`)
  })
})

describe('planFormsManifest and generateFormTypes', () => {
  let root: string
  const definitions = [route('posts.store', z.object({ title: z.string() }))]

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-forms-types-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function app(options: { dependsOnClient: boolean; clientExports?: Record<string, unknown> }): Promise<void> {
    const dependencies = options.dependsOnClient ? { '@guren/inertia-client': '^1.3.0' } : {}
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }))
    if (options.clientExports) {
      const client = join(root, 'node_modules/@guren/inertia-client')
      await mkdir(client, { recursive: true })
      await writeFile(join(client, 'package.json'), JSON.stringify({ name: '@guren/inertia-client', exports: options.clientExports }))
    }
  }

  it('skips an app that does not depend on the client, and removes a stale file', async () => {
    await app({ dependsOnClient: false })
    await mkdir(join(root, '.guren'))
    await writeFile(join(root, FORMS_MANIFEST_FILE), 'stale')
    expect(await planFormsManifest(root, definitions)).toEqual({ kind: 'skip', reason: 'no-client' })
    await generateFormTypes(definitions, { appRoot: root, force: true })
    expect(await readFile(join(root, FORMS_MANIFEST_FILE), 'utf8').catch(() => null)).toBeNull()
  })

  it('skips with the upgrade line when the installed client predates the forms subpath', async () => {
    await app({ dependsOnClient: true, clientExports: { '.': './dist/index.js', './package.json': './package.json' } })
    const plan = await planFormsManifest(root, definitions)
    expect(plan).toMatchObject({ kind: 'skip', reason: 'client-without-forms' })
    const { outputPath, warnings } = await generateFormTypes(definitions, { appRoot: root, force: true })
    expect(outputPath).toBe('')
    expect(warnings.join('\n')).toContain('bun add @guren/inertia-client@latest')
  })

  it('writes the file once the installed client exports ./forms', async () => {
    await app({ dependsOnClient: true, clientExports: { './forms': './dist/forms.js', './package.json': './package.json' } })
    const { outputPath } = await generateFormTypes(definitions, { appRoot: root, force: true })
    expect(outputPath).not.toBe('')
    expect(await readFile(join(root, FORMS_MANIFEST_FILE), 'utf8')).toContain('postsStoreForm')
  })
})

describe('FieldInput', () => {
  // The CLI cannot import the client, so both vocabularies are read as text.
  const union = (source: string) => {
    const body = /export type FieldInput =([\s\S]*?)\n\n/u.exec(source)?.[1] ?? ''
    return [...body.matchAll(/'([a-z]+)'/gu)].map((match) => match[1]!)
  }

  it('starts from the plan view input vocabulary', async () => {
    const [client, plan] = await Promise.all([
      readFile(join(import.meta.dir, '../../inertia-client/src/forms.ts'), 'utf8'),
      readFile(join(import.meta.dir, '../src/plan/schema.ts'), 'utf8'),
    ])
    const planInputs = /input: z\.enum\(\[([^\]]+)\]\)/u.exec(plan)?.[1]?.match(/'([a-z]+)'/gu)?.map((value) => value.slice(1, -1)) ?? []
    expect(planInputs.length).toBeGreaterThan(5)
    expect(planInputs.filter((input) => !union(client).includes(input))).toEqual([])
  })

  it('mirrors the client FieldContract in the CLI', async () => {
    const keys = (source: string) => {
      const body = /export interface FieldContract \{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? ''
      return [...body.matchAll(/^\s+([a-zA-Z]+)\??:/gmu)].map((match) => match[1]!).sort()
    }
    const [client, cli] = await Promise.all([
      readFile(join(import.meta.dir, '../../inertia-client/src/forms.ts'), 'utf8'),
      readFile(join(import.meta.dir, '../src/forms-types.ts'), 'utf8'),
    ])
    expect(keys(client).length).toBeGreaterThan(8)
    expect(keys(cli)).toEqual(keys(client))
  })
})
