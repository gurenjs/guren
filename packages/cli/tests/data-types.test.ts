import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateDataTypes } from '../src/data-types'
import { makeResource } from '../src/make-resource'
import { checkTypes, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'

/**
 * A Resource shaped the way `make:resource` scaffolds one — the explicit
 * `<Name>ResourceData` interface is what the extractor reads.
 */
function resourceFixture(className: string, fields: string): string {
  const dataName = `${className}Data`
  return (
    "import { Resource } from '@guren/core'\n\n"
    + `export interface ${dataName} extends Record<string, unknown> {\n`
    + `  ${fields}\n`
    + '}\n\n'
    + `export class ${className} extends Resource<Record<string, unknown>> {\n`
    + `  toArray(): ${dataName} {\n`
    + '    return {} as never\n'
    + '  }\n'
    + '}\n'
  )
}

/**
 * A `PostResource` file carrying `declarations` verbatim above the class, with
 * `toArray()` annotated as `returnType` when one is given. For the cases where
 * the declaration is the subject and the class around it is only scaffolding.
 */
function postResourceFile(declarations: string, returnType?: string, className = 'PostResource'): string {
  return (
    "import { Resource } from '@guren/core'\n\n"
    + `${declarations}\n\n`
    + `export class ${className} extends Resource<Record<string, unknown>> {\n`
    + `  toArray()${returnType ? `: ${returnType}` : ''} {\n`
    + '    return {} as never\n'
    + '  }\n'
    + '}\n'
  )
}

describe('generateDataTypes discovers module resources', () => {
  let appRoot: string

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'guren-cli-data-types-'))
  })

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true })
  })

  const read = () => readFile(join(appRoot, '.guren/data.gen.ts'), 'utf8')

  it('extracts types from modules/<name>/app/Http/Resources', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts': resourceFixture('PostResource', 'id: number'),
      'modules/billing/app/Http/Resources/InvoiceResource.ts': resourceFixture(
        'InvoiceResource',
        'total: number',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    // Qualification is unconditional: qualifying only on collision would rename
    // Data.Invoice the day a second InvoiceResource appears, breaking whatever
    // already imported it.
    expect(definitions.map((d) => [d.className, d.dataName, d.module])).toEqual([
      ['PostResource', 'Post', null],
      ['InvoiceResource', 'BillingInvoice', 'billing'],
    ])

    const output = await read()
    expect(output).toContain('export type Post = {\n  id: number\n}')
    expect(output).toContain('export type BillingInvoice = {\n  total: number\n}')
  })

  it('kebab and snake module names become one PascalCase prefix', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/order-fulfilment/app/Http/Resources/ShipmentResource.ts': resourceFixture(
        'ShipmentResource',
        'id: number',
      ),
    })

    const { definitions } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.dataName)).toEqual(['OrderFulfilmentShipment'])
  })

  it('resolves the same class name in two modules to distinct data types', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/billing/app/Http/Resources/InvoiceResource.ts': resourceFixture(
        'InvoiceResource',
        'total: number',
      ),
      'modules/inventory/app/Http/Resources/InvoiceResource.ts': resourceFixture(
        'InvoiceResource',
        'sku: string',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.dataName).sort()).toEqual(['BillingInvoice', 'InventoryInvoice'])

    const output = await read()
    expect(output).toContain('export type BillingInvoice = {\n  total: number\n}')
    expect(output).toContain('export type InventoryInvoice = {\n  sku: string\n}')
  })

  it('keeps the first of two resources claiming one data name and warns', async () => {
    await writeWorkspaceFiles(appRoot, {
      // Root `BillingInvoiceResource` and billing's `InvoiceResource` both
      // want `Data.BillingInvoice` — module qualification cannot separate them.
      'app/Http/Resources/BillingInvoiceResource.ts': resourceFixture(
        'BillingInvoiceResource',
        'total: number',
      ),
      'modules/billing/app/Http/Resources/InvoiceResource.ts': resourceFixture(
        'InvoiceResource',
        'sku: string',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    // The loser keeps its identity and loses only its name: the class still
    // occupies `InvoiceResource`, which is what stops a hint naming it from
    // resolving to the winner's payload.
    expect(definitions.map((d) => [d.className, d.dataName])).toEqual([
      ['BillingInvoiceResource', 'BillingInvoice'],
      ['InvoiceResource', null],
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('modules/billing/app/Http/Resources/InvoiceResource.ts')
    expect(warnings[0]).toContain('app/Http/Resources/BillingInvoiceResource.ts')
    expect(warnings[0]).toContain('"BillingInvoice"')

    // One `export type BillingInvoice` — two would not compile.
    const output = await read()
    expect(output.match(/export type BillingInvoice\b/gu)).toHaveLength(1)
    expect(output).not.toContain('sku: string')
  })

  it('omits a resource whose module qualifier is not a valid identifier', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/2fa/app/Http/Resources/TokenResource.ts': resourceFixture('TokenResource', 'id: number'),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => [d.className, d.dataName])).toEqual([['TokenResource', null]])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"2faToken"')
    expect(warnings[0]).toContain('modules/2fa/')
    expect(await read()).toContain('// No resources found')
  })

  it('omits a resource whose name is identifier-shaped but reserved', async () => {
    await writeWorkspaceFiles(appRoot, {
      // `Data.default` passes an identifier regex and is a syntax error.
      'app/Http/Resources/defaultResource.ts': resourceFixture('defaultResource', 'id: number'),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.dataName)).toEqual([null])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"default"')
  })

  it(
    'emits a data.gen.ts that compiles even when every rule has to fire at once',
    async () => {
      await writeWorkspaceFiles(appRoot, {
        'app/Http/Resources/PostResource.ts': resourceFixture('PostResource', 'id: number'),
        'app/Http/Resources/BillingInvoiceResource.ts': resourceFixture('BillingInvoiceResource', 'total: number'),
        'app/Http/Resources/defaultResource.ts': resourceFixture('defaultResource', 'id: number'),
        'modules/billing/app/Http/Resources/InvoiceResource.ts': resourceFixture('InvoiceResource', 'sku: string'),
        'modules/2fa/app/Http/Resources/TokenResource.ts': resourceFixture('TokenResource', 'id: number'),
      })

      const { outputPath, warnings } = await generateDataTypes({ appRoot, force: true })

      // Compiled, not regex-matched: the whole point of dropping definitions is
      // that the artifact stays usable, and a substring check cannot say that.
      expect(warnings).toHaveLength(3)
      expect(
        checkTypes([outputPath], {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          types: [],
        }),
      ).toEqual([])
    },
    TSC_TIMEOUT,
  )

  it('emits definitions in a deterministic order, root before modules', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/zeta/app/Http/Resources/ZetaResource.ts': resourceFixture('ZetaResource', 'id: number'),
      'modules/alpha/app/Http/Resources/AlphaResource.ts': resourceFixture('AlphaResource', 'id: number'),
      'app/Http/Resources/RootResource.ts': resourceFixture('RootResource', 'id: number'),
    })

    const { definitions } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.filePath)).toEqual([
      'app/Http/Resources/RootResource.ts',
      'modules/alpha/app/Http/Resources/AlphaResource.ts',
      'modules/zeta/app/Http/Resources/ZetaResource.ts',
    ])
  })

  it('resolves a module-versus-module collision by path order, not discovery order', async () => {
    await writeWorkspaceFiles(appRoot, {
      // Both qualify to `Data.ZebraInvoice` and neither is structurally
      // favoured the way the project root is, so only the path sort decides.
      // It compares bytewise: '-' (0x2D) sorts before '/' (0x2F), which a
      // locale-aware compare is free to disagree with.
      'modules/zebra/app/Http/Resources/InvoiceResource.ts': resourceFixture('InvoiceResource', 'a: number'),
      'modules/zebra-in/app/Http/Resources/voiceResource.ts': resourceFixture('voiceResource', 'b: number'),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => [d.filePath, d.dataName])).toEqual([
      ['modules/zebra-in/app/Http/Resources/voiceResource.ts', 'ZebraInvoice'],
      ['modules/zebra/app/Http/Resources/InvoiceResource.ts', null],
    ])
    expect(warnings).toHaveLength(1)
  })

  it('names the module fan-out in the generated header', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts': resourceFixture('PostResource', 'id: number'),
    })

    await generateDataTypes({ appRoot, force: true })

    expect(await read()).toContain('// Generated from app/Http/Resources (and modules/*/app/Http/Resources)')
  })

  it('fans an explicit resourcesDir out over modules, like the default', async () => {
    await writeWorkspaceFiles(appRoot, {
      'custom/Resources/PostResource.ts': resourceFixture('PostResource', 'id: number'),
      'modules/billing/custom/Resources/InvoiceResource.ts': resourceFixture('InvoiceResource', 'total: number'),
      // Relocating the directory must not also opt out of the test-file
      // exclusion the conventional path gets.
      'custom/Resources/GhostResource.test.ts': resourceFixture('GhostResource', 'id: number'),
      'app/Http/Resources/IgnoredResource.ts': resourceFixture('IgnoredResource', 'id: number'),
    })

    const { definitions } = await generateDataTypes({
      appRoot,
      resourcesDir: 'custom/Resources',
      force: true,
    })

    expect(definitions.map((d) => d.dataName)).toEqual(['Post', 'BillingInvoice'])
    expect(await read()).toContain('// Generated from custom/Resources (and modules/*/custom/Resources)')
  })

  it('leaves the project with no resources at all producing an empty namespace', async () => {
    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions).toEqual([])
    expect(warnings).toEqual([])
    expect(await read()).toContain('// No resources found')
  })
})

/**
 * A Resource outside the recognised subset of `toArray()` shapes type-checks
 * and serves fine; the only symptom is a `Data` member that never appears, so
 * every miss has to name itself and the shape it wanted.
 */
describe('generateDataTypes reports Resource classes it could not extract', () => {
  let appRoot: string

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'guren-cli-data-types-miss-'))
  })

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true })
  })

  const read = () => readFile(join(appRoot, '.guren/data.gen.ts'), 'utf8')

  it('warns about a toArray() that returns an unannotated object literal', async () => {
    await writeWorkspaceFiles(appRoot, {
      // The reported case, verbatim: valid TypeScript, correct at runtime, and
      // invisible to a regex looking for a return annotation.
      'app/Http/Resources/PostResource.ts':
        "import { Resource } from '@guren/core'\n"
        + "import type { PostRecord } from '../../Models/Post.js'\n\n"
        + 'export class PostResource extends Resource<PostRecord> {\n'
        + '  toArray() {\n'
        + '    return { id: this.resource.id, title: this.resource.title }\n'
        + '  }\n'
        + '}\n',
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('PostResource')
    expect(warnings[0]).toContain('app/Http/Resources/PostResource.ts')
    // The fix has to be quotable from the message alone, in the convention
    // `make:resource` emits.
    expect(warnings[0]).toContain('export interface PostResourceData')
    expect(warnings[0]).toContain('toArray(): PostResourceData')

    // Still a tombstone, so a same-named Resource elsewhere cannot resolve a
    // response hint to this one's payload.
    expect(definitions.map((d) => [d.className, d.dataName, d.rawType])).toEqual([
      ['PostResource', null, null],
    ])
    expect(await read()).toContain('// No resources found')
  })

  it('names the module path of an unextractable module resource', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/billing/app/Http/Resources/InvoiceResource.ts':
        "import { Resource } from '@guren/core'\n\n"
        + 'export class InvoiceResource extends Resource<Record<string, unknown>> {\n'
        + '  toArray() {\n'
        + '    return { total: 0 }\n'
        + '  }\n'
        + '}\n',
    })

    const { warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('modules/billing/app/Http/Resources/InvoiceResource.ts')
    expect(warnings[0]).toContain('export interface InvoiceResourceData')
  })

  it('says so when the annotated type lives in another file', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/types.ts': 'export interface PostPayload {\n  id: number\n}\n',
      'app/Http/Resources/PostResource.ts':
        "import { Resource } from '@guren/core'\n"
        + "import type { PostPayload } from './types.js'\n\n"
        + 'export class PostResource extends Resource<Record<string, unknown>> {\n'
        + '  toArray(): PostPayload {\n'
        + '    return {} as never\n'
        + '  }\n'
        + '}\n',
    })

    const { warnings } = await generateDataTypes({ appRoot, force: true })

    // A declaration that is merely elsewhere needs "move it here": the generic
    // message sends the author looking for something already written.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('PostPayload')
    expect(warnings[0]).toContain('is declared in that file')
    expect(warnings[0]).toContain('move the declaration into it')
  })

  it('refuses an uncopyable type that is not exported, and says export fixes it', async () => {
    await writeWorkspaceFiles(appRoot, {
      // A reference to an unexported name is a TS2694 that takes the whole
      // artifact out of compilation, and "export it" is the one-word fix the
      // default rewrite-the-shape advice would never mention.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        'type PostPayload = { id: number } & { title: string }',
        'PostPayload',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.rawType)).toEqual([null])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Export PostPayload so data.gen.ts can reference the declaration')
  })

  it('tells the author to close an unterminated body instead of rewriting it', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts':
        "import { Resource } from '@guren/core'\n\n"
        + 'export interface PostResourceData {\n  id: number\n\n'
        + 'export class PostResource extends Resource<Record<string, unknown>> {\n'
        + '  toArray(): PostResourceData {\n'
        + '    return {} as never\n'
        + '  }\n'
        + '}\n',
    })

    const { warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('opens a body that is never closed')
    expect(warnings[0]).toContain('Close it.')
    expect(warnings[0]).not.toContain('with its members inline')
  })

  it('names the type parameters rather than calling a generic a non-object', async () => {
    await writeWorkspaceFiles(appRoot, {
      // Refusing is right — `{ id: T }` copied out of its declaration does not
      // compile — but "not a plain object type" sends the author to rewrite
      // the shape instead of the one thing in the way.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        'export interface PostResourceData<T = string> {\n  id: T\n}',
        'PostResourceData',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.rawType)).toEqual([null])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('takes type parameters')
    expect(warnings[0]).not.toContain('is not a plain object type')
  })

  it('still reads an alias whose object body stands alone', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts': postResourceFile(
        'export type PostResourceData = {\n  id: number\n}',
        'PostResourceData',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual(['{\n  id: number\n}'])
  })

  it('quotes an annotation it does not read instead of calling it absent', async () => {
    await writeWorkspaceFiles(appRoot, {
      // A qualified name is a return type, just not one Strategy 2 reads.
      // Telling the author they wrote none sends them to add a second.
      'app/Http/Resources/PostResource.ts':
        "import { Resource } from '@guren/core'\n"
        + "import type * as Types from './types.js'\n\n"
        + 'export class PostResource extends Resource<Record<string, unknown>> {\n'
        + '  toArray(): Types.PostPayload {\n'
        + '    return {} as never\n'
        + '  }\n'
        + '}\n',
    })

    const { warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('annotates toArray(): Types.PostPayload')
    expect(warnings[0]).not.toContain('no toArray() return type')
  })

  it('stays silent for the shape make:resource scaffolds', async () => {
    // Generated by the scaffolder rather than restated here: a hand-copied
    // fixture stops proving this the day the template changes.
    await makeResource('Post', { cwd: appRoot, model: 'Post' })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.dataName)).toEqual(['Post'])
  })
})

describe('generateDataTypes references exported types it cannot copy', () => {
  let appRoot: string

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'guren-cli-data-types-ref-'))
  })

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true })
  })

  const POST_REFERENCE = "import('../app/Http/Resources/PostResource').PostResourceData"

  // One row per uncopyable-but-referencable shape; why a *copy* would be wrong
  // rides with each row.
  const REFERENCED_SHAPES: Array<[title: string, declarations: string]> = [
    [
      // `extends[^{;]*` stops at the generic argument's brace, so a copy would
      // emit the argument — a payload the route never sends. The reference
      // resolves the interface, heritage and all.
      'a declaration whose extends clause holds an object type',
      'export interface PostResourceData extends Record<string, { nested: true }> {\n'
      + '  id: number\n}',
    ],
    [
      // Copying either block alone drops the other's members — a type that
      // compiles and is wrong. The reference resolves to the merged type.
      'a type merged across two declarations',
      'export interface PostResourceData {\n  id: number\n}\n\n'
      + 'export interface PostResourceData {\n  title: string\n}',
    ],
    [
      'an alias that composes its object body with another type',
      'export type PostResourceData = { id: number } & { title: string }',
    ],
    [
      // `{ … }[]` is an array of the body and `{ … }['k']` is one member of
      // it. Copying the body describes neither; the reference names the alias.
      'an alias that uses its body as an operand',
      'export type PostResourceData = { id: number }[]',
    ],
    [
      'an alias indexed into, rather than emitting what it indexes',
      "export type PostResourceData = { payload: { id: number } }['payload']",
    ],
    [
      // `declare` breaks a reader that expects `interface|type` right after
      // the optional `export` — and a modifier only one of the two readers
      // admits would split the verdict between them.
      'a declare-modified alias',
      'export declare type PostResourceData = { id: number } & { title: string }',
    ],
  ]

  for (const [title, declarations] of REFERENCED_SHAPES) {
    it(`references ${title}`, async () => {
      await writeWorkspaceFiles(appRoot, {
        'app/Http/Resources/PostResource.ts': postResourceFile(declarations, 'PostResourceData'),
      })

      const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

      expect(warnings).toEqual([])
      expect(definitions.map((d) => d.rawType)).toEqual([POST_REFERENCE])
    })
  }

  it('prefers a plainly-named export specifier over an unspellable alias', async () => {
    await writeWorkspaceFiles(appRoot, {
      // The dotted reference cannot spell `'wire-name'`; the second specifier
      // exports the same declaration under its own name and must win however
      // the list orders them.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        'type PostPayload = { id: number } & { title: string }\n\n'
        + "export type { PostPayload as 'wire-name', PostPayload }",
        'PostPayload',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual([
      "import('../app/Http/Resources/PostResource').PostPayload",
    ])
  })

  it(
    'emits a reference tsc can compile and resolve',
    async () => {
      await writeWorkspaceFiles(appRoot, {
        // Self-contained on purpose (no @guren/core import): tsc follows the
        // reference into this file, so everything it imports must resolve.
        'app/Http/Resources/PostResource.ts':
          'declare class Resource<T> { constructor(resource: T) }\n\n'
          + 'export type PostResourceData = { id: number } & { title: string }\n\n'
          + 'export class PostResource extends Resource<Record<string, unknown>> {\n'
          + '  toArray(): PostResourceData {\n'
          + '    return {} as never\n'
          + '  }\n'
          + '}\n',
      })

      const { outputPath, definitions, warnings } = await generateDataTypes({ appRoot, force: true })

      expect(warnings).toEqual([])
      expect(definitions.map((d) => d.rawType)).toEqual([POST_REFERENCE])
      expect(
        checkTypes([outputPath], {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          types: [],
        }),
      ).toEqual([])
    },
    TSC_TIMEOUT,
  )

  it('references an exported annotated type it cannot copy', async () => {
    await writeWorkspaceFiles(appRoot, {
      // An intersection has no body to copy into the namespace — but the
      // declaration is exported, so a reference to it cannot be wrong the way
      // a guessed body could.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        "import type { PostRecord } from '../../Models/Post.js'\n\n"
        + 'export type PostPayload = PostRecord & { extra: string }',
        'PostPayload',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual([
      "import('../app/Http/Resources/PostResource').PostPayload",
    ])
    // The file's type imports must not ride along: the reference resolves
    // inside the resource's own module, and a same-named import from another
    // root would collide in the shared import block.
    expect(definitions.map((d) => d.imports)).toEqual([[]])
    expect(await readFile(join(appRoot, '.guren/data.gen.ts'), 'utf8')).not.toContain('PostRecord')
  })

  it('references the annotated type when it is an exported z.infer alias', async () => {
    await writeWorkspaceFiles(appRoot, {
      // The motivating case: one zod schema as the single source of truth for
      // the runtime contract (`output:`) and the Resource's payload type.
      'app/Http/Resources/TaskResource.ts':
        "import { Resource } from '@guren/core'\n"
        + "import { z } from 'zod'\n\n"
        + 'export const TaskResourceSchema = z.object({ id: z.number(), title: z.string() })\n'
        + 'export type TaskResourceData = z.infer<typeof TaskResourceSchema>\n\n'
        + 'export class TaskResource extends Resource<Record<string, unknown>> {\n'
        + '  toArray(): TaskResourceData {\n'
        + '    return {} as never\n'
        + '  }\n'
        + '}\n',
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => [d.dataName, d.rawType])).toEqual([
      ['Task', "import('../app/Http/Resources/TaskResource').TaskResourceData"],
    ])
  })

  it('references a module resource through its modules/ path', async () => {
    await writeWorkspaceFiles(appRoot, {
      'modules/billing/app/Http/Resources/InvoiceResource.ts': postResourceFile(
        'export type InvoiceResourceData = { total: number } & { currency: string }',
        'InvoiceResourceData',
        'InvoiceResource',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => [d.dataName, d.rawType])).toEqual([
      [
        'BillingInvoice',
        "import('../modules/billing/app/Http/Resources/InvoiceResource').InvoiceResourceData",
      ],
    ])
  })

  it('references a type exported through an export list', async () => {
    await writeWorkspaceFiles(appRoot, {
      // `export type { X }` exports without an `export` keyword on the
      // declaration line — which is why exportedness is read from the AST, not
      // from the line the declaration sits on.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        'type PostPayload = { id: number } & { title: string }\n\n'
        + 'export type { PostPayload }',
        'PostPayload',
      ),
    })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual([
      "import('../app/Http/Resources/PostResource').PostPayload",
    ])
  })

})

/**
 * The type body is copied verbatim into `data.gen.ts`, so reading one byte too
 * many is worse than reading none: an over-captured body takes the whole
 * artifact out of compilation, unwarned, because extraction "succeeded".
 */
describe('generateDataTypes reads a type body by brace depth', () => {
  let appRoot: string

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'guren-cli-data-types-body-'))
  })

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true })
  })

  const writeResource = (declarations: string, returnType?: string) =>
    writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts': postResourceFile(declarations, returnType),
    })

  it(
    'stops a one-line interface at its own closing brace',
    async () => {
      await writeResource('export interface PostResourceData { id: number }', 'PostResourceData')

      const { outputPath, definitions, warnings } = await generateDataTypes({ appRoot, force: true })

      expect(warnings).toEqual([])
      expect(definitions.map((d) => d.rawType)).toEqual(['{ id: number }'])
      // Compiled rather than substring-matched: over-capture leaves a
      // `data.gen.ts` that still *contains* the right text, so only tsc can
      // tell the two apart.
      expect(
        checkTypes([outputPath], {
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          target: 'ES2022',
          types: [],
        }),
      ).toEqual([])
    },
    TSC_TIMEOUT,
  )

  it('reads a plain local interface named by the annotation', async () => {
    // No `extends` and no `=` — the shape a hand-written resource lands on
    // when the payload type is not named after the class.
    await writeResource('export interface PostPayload {\n  id: number\n}', 'PostPayload')

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual(['{\n  id: number\n}'])
  })

  it('keeps a nested object whole', async () => {
    await writeResource(
      'export interface PostResourceData {\n'
      + '  author: {\n    id: number\n  }\n'
      + '  id: number\n'
      + '}',
      'PostResourceData',
    )

    const { definitions } = await generateDataTypes({ appRoot, force: true })

    // The trailing `id` proves the reader did not stop at the nested type's
    // closing brace.
    expect(definitions[0]?.rawType).toBe('{\n  author: {\n    id: number\n  }\n  id: number\n}')
  })

  it('does not count braces inside comments or string literal types', async () => {
    await writeResource(
      'export interface PostResourceData {\n'
      + "  // Serialized as '}' by the legacy encoder — see ADR 0003.\n"
      + "  marker: '}'\n"
      + '  id: number\n'
      + '}',
      'PostResourceData',
    )

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions[0]?.rawType).toContain('id: number')
    expect(definitions[0]?.rawType?.endsWith('\n}')).toBe(true)
  })

  it('ignores a declaration that is only a commented-out draft', async () => {
    // The ordinary way a file comes to hold two declarations of one name: the
    // previous shape left above the current one. Reading the comment yields a
    // `Data` member describing a payload the app stopped sending.
    await writeResource(
      '// interface PostResourceData { bogus: string }\n'
      + '/* export interface PostResourceData {\n  alsoBogus: string\n} */\n\n'
      + 'export interface PostResourceData {\n  id: number\n}',
      'PostResourceData',
    )

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions[0]?.rawType).toBe('{\n  id: number\n}')
  })

  it('keeps a template literal type whose expression nests another template', async () => {
    // The inner backtick closes nothing; read as this template's delimiter it
    // ends the literal early and the body is truncated mid-property.
    await writeResource(
      'export interface PostResourceData {\n'
      + '  value: `${string extends string ? `}` : never}`\n'
      + '  id: number\n'
      + '}',
      'PostResourceData',
    )

    const { definitions } = await generateDataTypes({ appRoot, force: true })

    expect(definitions[0]?.rawType?.endsWith('  id: number\n}')).toBe(true)
  })

  it('ignores a same-named declaration nested in an inner scope', async () => {
    // A type inside a function body is a different type that merely shares the
    // name. Counting it as a second block costs the real one its `Data` member.
    await writeResource(
      'export interface PostResourceData { id: number }\n\n'
      + 'function hidden() {\n'
      + '  interface PostResourceData { hidden: string }\n'
      + '  return null\n'
      + '}',
      'PostResourceData',
    )

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual(['{ id: number }'])
  })

  it('does not take a namespaced declaration for the payload type', async () => {
    // Nothing at the top level declares the payload, so the members of an
    // unrelated scoped type must not be emitted as `Data.Post`.
    await writeResource(
      'namespace Hidden {\n  export interface PostResourceData { hidden: string }\n}',
    )

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.rawType)).toEqual([null])
    expect(warnings).toHaveLength(1)
  })

  it('reads a declaration whose brace opens on the next line', async () => {
    await writeResource('export interface PostResourceData\n{\n  id: number\n}', 'PostResourceData')

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual(['{\n  id: number\n}'])
  })

  it('references a same-named alias that declares no object type', async () => {
    // `type PostResourceData = string` has no body; walking forward to the next
    // `{` would hand back the class declaration below it. Exported, the alias
    // is referenced instead.
    await writeResource('export type PostResourceData = string')

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.rawType)).toEqual([
      "import('../app/Http/Resources/PostResource').PostResourceData",
    ])
  })
})
