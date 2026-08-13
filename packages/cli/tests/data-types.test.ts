import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { generateDataTypes } from '../src/data-types'
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
