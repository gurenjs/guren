import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isUnreadable, loadPlanAppState } from '../src/plan/app-state'
import { writeWorkspaceFiles } from './helpers'

const CONTROLLER = `import { Controller } from '@guren/core'

export class PostController extends Controller {
  async index() {}
  store = async () => {}
}
`

const MODEL = `import { defineModel } from '@guren/core'
import { posts } from '@/db/schema'

export class Post extends defineModel(posts) {}
`

const SCHEMA = `import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})
`

describe('loadPlanAppState', () => {
  let cwd: string

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'guren-plan-state-'))
  })

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  test('should read controller classes and their actions', async () => {
    await writeWorkspaceFiles(cwd, { 'app/Http/Controllers/PostController.ts': CONTROLLER })

    const state = await loadPlanAppState(cwd)

    expect(state.controllers).toEqual([{ name: 'PostController', module: null }])
    // A class-field action dispatches like a method, so both forms must be listed.
    expect(state.actions).toEqual([
      { name: 'PostController.index', module: null },
      { name: 'PostController.store', module: null },
    ])
  })

  test("should tag each name with the app root its file sits in", async () => {
    await writeWorkspaceFiles(cwd, {
      'app/Models/Post.ts': MODEL,
      'app/Http/Controllers/PostController.ts': CONTROLLER,
      'modules/billing/index.ts': 'export default {}\n',
      'modules/billing/app/Models/Invoice.ts': MODEL.replace(/Post/g, 'Invoice').replace(/posts/g, 'invoices'),
      'modules/billing/app/Http/Controllers/InvoiceController.ts': CONTROLLER.replace(/PostController/, 'InvoiceController'),
      'modules/billing/app/Policies/InvoicePolicy.ts': 'export class InvoicePolicy {}\n',
    })

    const state = await loadPlanAppState(cwd)

    expect(state.models).toEqual([
      { name: 'Invoice', module: 'billing' },
      { name: 'Post', module: null },
    ])
    expect(state.controllers).toContainEqual({ name: 'InvoiceController', module: 'billing' })
    expect(state.actions).toContainEqual({ name: 'InvoiceController.index', module: 'billing' })
    expect(state.policies).toEqual([{ name: 'InvoicePolicy', module: 'billing' }])
  })

  test('should report controllers and actions as unreadable when a file does not parse', async () => {
    await writeWorkspaceFiles(cwd, {
      'app/Http/Controllers/PostController.ts': CONTROLLER,
      'app/Http/Controllers/BrokenController.ts': 'export class Broken extends {{{',
    })

    const state = await loadPlanAppState(cwd)

    expect(isUnreadable(state.controllers)).toBe(true)
    expect(isUnreadable(state.actions)).toBe(true)
    expect(state.controllers).toMatchObject({ unreadable: expect.stringContaining('BrokenController.ts') })
  })

  test('should read a declared table with its columns', async () => {
    await writeWorkspaceFiles(cwd, { 'db/schema.ts': SCHEMA })

    const state = await loadPlanAppState(cwd)

    expect(state.tables).toEqual([{ identifier: 'posts', tableName: 'posts', module: null, columns: ['id', 'title'] }])
  })

  test("should tag a module's table with the module that declares it", async () => {
    await writeWorkspaceFiles(cwd, {
      'modules/billing/index.ts': 'export default {}\n',
      'modules/billing/db/schema.ts': SCHEMA.replace(/posts/g, 'invoices'),
    })

    const state = await loadPlanAppState(cwd)

    expect(state.tables).toEqual([{ identifier: 'invoices', tableName: 'invoices', module: 'billing', columns: ['id', 'title'] }])
  })

  test('should report tables as unreadable when a present schema yields none', async () => {
    await writeWorkspaceFiles(cwd, { 'db/schema.ts': 'export const nothing = 1\n' })

    const state = await loadPlanAppState(cwd)

    expect(state.tables).toMatchObject({ unreadable: expect.stringContaining('db/schema.ts') })
  })

  test('should report a module schema that yields nothing even when the root one parses', async () => {
    await writeWorkspaceFiles(cwd, {
      'db/schema.ts': SCHEMA,
      'modules/billing/db/schema.ts': 'export const nothing = 1\n',
      'modules/billing/index.ts': 'export default {}\n',
    })

    const state = await loadPlanAppState(cwd)

    expect(state.tables).toMatchObject({ unreadable: expect.stringContaining('modules/billing/db/schema.ts') })
  })

  test('should read an app with no schema file as having no table', async () => {
    const state = await loadPlanAppState(cwd)

    expect(state.tables).toEqual([])
  })

  test('should report routes as unreadable when the routes file throws without a message', async () => {
    await writeWorkspaceFiles(cwd, {
      'package.json': '{ "name": "empty-error", "type": "module" }\n',
      'routes/web.ts': 'throw new Error()\n',
    })

    const state = await loadPlanAppState(cwd)

    // An error with an empty message must not read as an app that has no routes.
    expect(isUnreadable(state.routes)).toBe(true)
  })

  test('should always report validators as unreadable', async () => {
    const state = await loadPlanAppState(cwd)

    expect(isUnreadable(state.validators)).toBe(true)
  })
})
