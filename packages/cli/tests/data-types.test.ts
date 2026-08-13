import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { generateDataTypes } from '../src/data-types'
import { makeResource } from '../src/make-resource'
import { checkTypes, COLD_TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'

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
function postResourceFile(declarations: string, returnType?: string): string {
  return (
    "import { Resource } from '@guren/core'\n\n"
    + `${declarations}\n\n`
    + 'export class PostResource extends Resource<Record<string, unknown>> {\n'
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
          target: ts.ScriptTarget.ES2022,
          types: [],
        }),
      ).toEqual([])
    },
    COLD_TSC_TIMEOUT,
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
 * and serves fine — the only symptom is a `Data` member that never appears. So
 * every miss has to name itself and the shape it wanted, or the run reports
 * success while the artifact describes less than the app does.
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
    // The fix has to be quotable from the message alone — that is the whole
    // point of it, and it must spell the convention `make:resource` emits.
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

    // A declaration that is merely elsewhere needs "move it here", not "write
    // one" — the generic message sends the author looking for something that
    // is already written.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('PostPayload')
    expect(warnings[0]).toContain('is declared in that file')
    expect(warnings[0]).toContain('move the declaration into it')
  })

  it('says so when the annotated type is here but is not an object type', async () => {
    await writeWorkspaceFiles(appRoot, {
      // An intersection has no body to copy into the namespace. The
      // declaration is right here, so telling the author to write one would
      // send them looking for something they can already see.
      'app/Http/Resources/PostResource.ts': postResourceFile(
        "import type { PostRecord } from '../../Models/Post.js'\n\n"
        + 'export type PostPayload = PostRecord & { extra: string }',
        'PostPayload',
      ),
    })

    const { warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('declares PostPayload in that file')
    expect(warnings[0]).toContain('only a plain object type can be copied')
    expect(warnings[0]).not.toContain('move the declaration into it')
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
    // Generated by the scaffolder rather than restated here: a warning the
    // framework's own output triggers would be the message being wrong, and a
    // hand-copied fixture stops proving that the day the template changes.
    await makeResource('Post', { cwd: appRoot, model: 'Post' })

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(warnings).toEqual([])
    expect(definitions.map((d) => d.dataName)).toEqual(['Post'])
  })
})

/**
 * The type body is copied verbatim into `data.gen.ts`, so reading one byte too
 * many is worse than reading none: an over-captured body takes the whole
 * artifact — every other resource's type with it — out of compilation, and
 * nothing warns, because extraction "succeeded".
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
          target: ts.ScriptTarget.ES2022,
          types: [],
        }),
      ).toEqual([])
    },
    COLD_TSC_TIMEOUT,
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

  it('ignores a same-named alias that declares no object type', async () => {
    // `type PostResourceData = string` has no body; walking forward to the
    // next `{` would hand back the class declaration below it.
    await writeResource('export type PostResourceData = string')

    const { definitions, warnings } = await generateDataTypes({ appRoot, force: true })

    expect(definitions.map((d) => d.rawType)).toEqual([null])
    expect(warnings).toHaveLength(1)
  })
})
