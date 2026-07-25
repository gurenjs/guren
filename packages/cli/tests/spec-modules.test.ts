import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { generateModulesSpec } from '../src/spec-modules'
import { SPEC_BANNER } from '../src/spec-generate'
import { createTempWorkspace, type TempWorkspace } from './helpers'

describe('modules spec (no modules directory)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-modules-none-')
    await mkdir(join(workspace.dir, 'app/Models'), { recursive: true })
    await writeFile(join(workspace.dir, 'package.json'), '{}', 'utf8')
    await writeFile(join(workspace.dir, 'app/Models/User.ts'), 'export class User {}\n', 'utf8')
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('emits a valid single-node document', async () => {
    const artifact = await generateModulesSpec(workspace.dir)

    expect(artifact.fileName).toBe('modules.md')
    const lines = artifact.content.split('\n')
    expect(lines[0]).toBe(SPEC_BANNER)
    expect(lines[1]).toBe('')
    expect(artifact.content.endsWith('\n')).toBe(true)
    expect(artifact.content.endsWith('\n\n')).toBe(false)

    expect(artifact.content).toContain('# Modules')
    expect(artifact.content).toContain('This app has no `modules/` directory')
    expect(artifact.content).toContain('```mermaid')
    expect(artifact.content).toContain('graph LR')
    expect(artifact.content).toContain('m_app["app<br/>User"]')
    expect(artifact.content).toContain('## app')
    expect(artifact.content).toContain('- User — app/Models/User.ts')
    expect(artifact.content).not.toContain('m_app -->')
  })
})

describe('modules spec (two modules with cross-module imports)', () => {
  let workspace: TempWorkspace

  beforeAll(async () => {
    workspace = await createTempWorkspace('guren-cli-spec-modules-')
    const dir = workspace.dir

    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await mkdir(join(dir, 'modules/billing/app/Models'), { recursive: true })
    await mkdir(join(dir, 'modules/billing/db'), { recursive: true })
    await mkdir(join(dir, 'modules/inventory-core/app/Models'), { recursive: true })
    await mkdir(join(dir, 'db'), { recursive: true })
    await writeFile(join(dir, 'package.json'), '{}', 'utf8')

    await writeFile(join(dir, 'app/Models/User.ts'), 'export class User {}\n', 'utf8')
    await writeFile(
      join(dir, 'modules/billing/app/Models/Invoice.ts'),
      'export class Invoice {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/app/Models/Payment.ts'),
      'export class Payment {}\n',
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/inventory-core/app/Models/Item.ts'),
      'export class Item {}\n',
      'utf8',
    )

    // app → billing: what `make:module` wires into the root schema.
    await writeFile(
      join(dir, 'db/schema.ts'),
      "export * from '../modules/billing/db/schema'\n",
      'utf8',
    )
    await writeFile(
      join(dir, 'modules/billing/db/schema.ts'),
      'export const invoices = {}\n',
      'utf8',
    )

    // billing → app: a module reaching back into root code.
    await writeFile(
      join(dir, 'modules/billing/service.ts'),
      "import { users } from '../../db/schema'\n\nexport const service = users\n",
      'utf8',
    )
    // billing → inventory-core, via the bare `modules/<name>/` specifier form.
    await writeFile(
      join(dir, 'modules/billing/report.ts'),
      "import { stock } from 'modules/inventory-core/index'\n\nexport const report = stock\n",
      'utf8',
    )
    // inventory-core → billing, via the `@/modules/<name>` barrel form, written
    // across lines — the dominant style for multi-symbol imports.
    await writeFile(
      join(dir, 'modules/inventory-core/index.ts'),
      `import {
  Invoice,
  Payment,
} from '@/modules/billing'

export const stock = [Invoice, Payment]
`,
      'utf8',
    )
  })

  afterAll(async () => {
    await workspace.cleanup()
  })

  it('renders one node per location with its models', async () => {
    const { content } = await generateModulesSpec(workspace.dir)

    expect(content).toContain('m_app["app<br/>User"]')
    expect(content).toContain('m_billing["billing<br/>Invoice, Payment"]')
    // Hyphenated module names are sanitized into the node id, not the label.
    expect(content).toContain('m_inventory_core["inventory-core<br/>Item"]')
  })

  it('records cross-module dependency edges in both directions', async () => {
    const { content } = await generateModulesSpec(workspace.dir)

    expect(content).toContain('  m_app --> m_billing')
    expect(content).toContain('  m_billing --> m_app')
    expect(content).toContain('  m_billing --> m_inventory_core')
    expect(content).toContain('  m_inventory_core --> m_billing')

    // No self-edges from same-location imports.
    expect(content).not.toContain('m_billing --> m_billing')
  })

  it('lists each location with its dependencies and model file paths', async () => {
    const { content } = await generateModulesSpec(workspace.dir)

    expect(content).toContain('## billing')
    expect(content).toContain('Depends on: app, inventory-core')
    expect(content).toContain('Models (2):')
    expect(content).toContain('- Invoice — modules/billing/app/Models/Invoice.ts')
    expect(content).toContain('- Payment — modules/billing/app/Models/Payment.ts')

    expect(content).toContain('## inventory-core')
    expect(content).toContain('- Item — modules/inventory-core/app/Models/Item.ts')
  })

  it('contains no absolute paths', async () => {
    const { content } = await generateModulesSpec(workspace.dir)

    expect(content).not.toContain(workspace.dir)
    expect(content).not.toContain('/private/')
  })

  it('is byte-identical across regeneration', async () => {
    const first = await generateModulesSpec(workspace.dir)
    const second = await generateModulesSpec(workspace.dir)

    expect(second.content).toBe(first.content)
  })
})
