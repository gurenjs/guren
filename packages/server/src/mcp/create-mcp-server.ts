import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

/**
 * CLI functions that the MCP server wraps.
 * These are injected at runtime to avoid circular dependencies
 * (@guren/server cannot depend on @guren/cli directly).
 */
export interface GurenCliApi {
  generateContext(opts: { cwd: string }): Promise<{
    framework: { name: string; version: string }
    models: Array<{ className: string }>
    routes: Array<unknown>
    pages: string[]
    controllers: string[]
    resources: string[]
    events: string[]
    jobs: string[]
    middleware: string[]
    listeners: string[]
    validators: string[]
  }>
  renderContextMarkdown(ctx: unknown): string
  generateEntityContext(entity: string, opts: { cwd: string; module?: string }): Promise<unknown>
  renderEntityContextMarkdown(ctx: unknown): string
  runCheck(opts: { cwd: string }): Promise<{
    cwd: string
    checks: Array<{ key: string; title: string; status: string; message: string; suggestion?: string }>
    passCount: number
    warnCount: number
    failCount: number
  }>
  listModels(opts: { appRoot: string }): Promise<
    Array<{
      className: string
      filePath: string
      tableName?: string
      relationships: Array<{ name: string; type: string; relatedModel?: string }>
      usesAuth: boolean
      hasSoftDeletes: boolean
    }>
  >
  generateGuidelines(opts: { cwd: string }): Promise<string>
  runDoctor(opts: { cwd: string }): Promise<unknown>
  suggestNextSteps(opts: { cwd: string }): Promise<unknown>
  makeFeature(
    name: string,
    opts: { fields?: string; withTest?: boolean; force?: boolean },
  ): Promise<string[]>
  makeController(name: string, opts: { force?: boolean }): Promise<string | string[]>
  makeModel(name: string, opts: { force?: boolean }): Promise<string | string[]>
  makeView(name: string, opts: { force?: boolean }): Promise<string | string[]>
  makeTest(name: string, opts: { force?: boolean }): Promise<string | string[]>
  makeRoute(name: string, opts: { force?: boolean }): Promise<string | string[]>
  generateRouteTypes(opts: { cwd: string }): Promise<unknown>
  generatePageTypes(opts: { cwd: string }): Promise<unknown>
  generateDataTypes(opts: { cwd: string }): Promise<unknown>
  generateChannelTypes(opts: { cwd: string }): Promise<unknown>
  /**
   * Route-dependent context generation that re-runs the CLI in a fresh
   * process. Optional because `@guren/cli` is resolved from the app at
   * runtime and may predate it — see `McpServiceProvider`.
   */
  createFreshContextApi?: () => Pick<GurenCliApi, 'generateContext' | 'generateEntityContext'>
}

export interface CreateMcpServerOptions {
  cwd: string
  cli: GurenCliApi
  version?: string
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const { cwd, cli, version = '0.2.0' } = options

  const server = new McpServer({
    name: 'guren',
    version,
  })

  // ─── Read-Only Tools ────────────────────────────────────────────

  server.tool(
    'guren_get_context',
    'Get a complete project context map including models, routes, pages, controllers, resources, events, jobs, middleware, listeners, and validators.',
    {
      format: z.enum(['json', 'markdown']).default('json').describe('Output format'),
    },
    async ({ format }) => {
      const ctx = await cli.generateContext({ cwd })
      const text =
        format === 'markdown' ? cli.renderContextMarkdown(ctx) : JSON.stringify(ctx, null, 2)
      return { content: [{ type: 'text', text }] }
    },
  )

  server.tool(
    'guren_entity_context',
    'Get everything about one entity in a single bundle: model (table, columns, relationships, reverse references), routes with validation schemas, controller actions, Inertia pages with props, resource, policy, seeders, and tests. Prefer this over guren_get_context when working on a specific model.',
    {
      entity: z.string().describe('Model class name (e.g., "User"). Case-insensitive.'),
      module: z
        .string()
        .optional()
        .describe('Module name to disambiguate same-named models across modules/; "app" selects the application root'),
      format: z.enum(['json', 'markdown']).default('markdown').describe('Output format'),
    },
    async ({ entity, module, format }) => {
      try {
        const ctx = await cli.generateEntityContext(entity, { cwd, module })
        const text =
          format === 'markdown'
            ? cli.renderEntityContextMarkdown(ctx)
            : JSON.stringify(ctx, null, 2)
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) },
          ],
          isError: true,
        }
      }
    },
  )

  server.tool(
    'guren_check',
    'Validate route-to-controller-to-page consistency, check for empty controller methods, missing test files, and missing generated manifests.',
    {},
    async () => {
      const report = await cli.runCheck({ cwd })
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] }
    },
  )

  server.tool(
    'guren_list_models',
    'List all models with their table names, relationships, authentication trait, and soft deletes status.',
    {},
    async () => {
      const models = await cli.listModels({ appRoot: cwd })
      return { content: [{ type: 'text', text: JSON.stringify(models, null, 2) }] }
    },
  )

  server.tool(
    'guren_generate_guidelines',
    'Generate project-specific coding guidelines based on the current project structure, naming conventions, auth setup, models, validation patterns, and middleware.',
    {},
    async () => {
      const guidelines = await cli.generateGuidelines({ cwd })
      return { content: [{ type: 'text', text: guidelines }] }
    },
  )

  server.tool(
    'guren_doctor',
    'Run a comprehensive health check on the Guren project and optionally suggest actionable next steps.',
    {
      next: z.boolean().default(false).describe('Include actionable next steps'),
    },
    async ({ next }) => {
      const report = await cli.runDoctor({ cwd })
      let text = JSON.stringify(report, null, 2)

      if (next) {
        const steps = await cli.suggestNextSteps({ cwd })
        text = JSON.stringify({ ...(report as Record<string, unknown>), nextSteps: steps }, null, 2)
      }

      return { content: [{ type: 'text', text }] }
    },
  )

  // ─── Write Tools ────────────────────────────────────────────────

  server.tool(
    'guren_make_feature',
    'Generate a complete CRUD feature: controller, model, views (Index, Show, New, Edit), validator, and resource. Optionally include test file.',
    {
      name: z.string().describe('Resource name in PascalCase (e.g., "Post", "BlogComment")'),
      fields: z
        .string()
        .optional()
        .describe(
          'Comma-separated field definitions (e.g., "title:string,body:text,published:boolean")',
        ),
      withTest: z.boolean().default(false).describe('Generate test file'),
      force: z.boolean().default(false).describe('Overwrite existing files'),
    },
    async ({ name, fields, withTest, force }) => {
      const originalCwd = process.cwd()
      try {
        process.chdir(cwd)
        const createdFiles = await cli.makeFeature(name, { fields, withTest, force })
        return {
          content: [{ type: 'text', text: JSON.stringify({ created: createdFiles }, null, 2) }],
        }
      } finally {
        process.chdir(originalCwd)
      }
    },
  )

  server.tool(
    'guren_make_component',
    'Generate a single component: controller, model, middleware, event, job, listener, resource, view, test, mail, notification, seeder, factory, or migration.',
    {
      type: z
        .enum([
          'controller',
          'model',
          'middleware',
          'event',
          'job',
          'listener',
          'resource',
          'view',
          'test',
          'mail',
          'notification',
          'seeder',
          'factory',
          'provider',
          'exception',
          'command',
          'channel',
        ])
        .describe('Component type to generate'),
      name: z.string().describe('Component name in PascalCase'),
      force: z.boolean().default(false).describe('Overwrite existing files'),
    },
    async ({ type, name, force }) => {
      const originalCwd = process.cwd()
      try {
        process.chdir(cwd)
        const makers: Record<
          string,
          ((name: string, opts: { force?: boolean }) => Promise<string | string[]>) | undefined
        > = {
          controller: cli.makeController,
          model: cli.makeModel,
          view: cli.makeView,
          test: cli.makeTest,
          route: cli.makeRoute,
        }

        const maker = makers[type]
        if (!maker) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Component type "${type}" is not yet supported via MCP. Use the CLI: bunx guren make:${type} ${name}`,
              },
            ],
            isError: true,
          }
        }

        const result = await maker(name, { force })
        const created = Array.isArray(result) ? result : [result]
        return {
          content: [{ type: 'text', text: JSON.stringify({ created }, null, 2) }],
        }
      } finally {
        process.chdir(originalCwd)
      }
    },
  )

  server.tool(
    'guren_codegen',
    'Generate type-safe route, page, data, and channel type manifests (.guren/*.gen.ts files).',
    {},
    async () => {
      const originalCwd = process.cwd()
      try {
        process.chdir(cwd)
        const generated: string[] = []

        try {
          await cli.generateRouteTypes({ cwd })
          generated.push('.guren/routes.gen.ts')
        } catch {
          /* skip if routes not configured */
        }

        try {
          await cli.generatePageTypes({ cwd })
          generated.push('.guren/pages.gen.ts')
        } catch {
          /* skip if pages not configured */
        }

        try {
          await cli.generateDataTypes({ cwd })
          generated.push('.guren/data.gen.ts')
        } catch {
          /* skip if resources not configured */
        }

        try {
          await cli.generateChannelTypes({ cwd })
          generated.push('.guren/channels.gen.ts')
        } catch {
          /* skip if channels not configured */
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ generated }, null, 2) }],
        }
      } finally {
        process.chdir(originalCwd)
      }
    },
  )

  // ─── Resources ──────────────────────────────────────────────────

  server.resource(
    'context',
    'guren://context',
    {
      description: 'Current project structure map (models, routes, pages, controllers, etc.)',
      mimeType: 'application/json',
    },
    async (uri) => {
      const ctx = await cli.generateContext({ cwd })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(ctx, null, 2),
          },
        ],
      }
    },
  )

  server.resource(
    'entity-context',
    new ResourceTemplate('guren://context/{entity}', { list: undefined }),
    {
      description:
        'Entity-centric context bundle: model, routes, controller, pages, resource, policy. For same-named models across modules, use the guren_entity_context tool with its module argument instead.',
      mimeType: 'text/markdown',
    },
    async (uri, variables) => {
      const ctx = await cli.generateEntityContext(String(variables.entity), { cwd })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: cli.renderEntityContextMarkdown(ctx),
          },
        ],
      }
    },
  )

  server.resource(
    'guidelines',
    'guren://guidelines',
    {
      description: 'Auto-generated project-specific coding guidelines',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      const guidelines = await cli.generateGuidelines({ cwd })
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: guidelines,
          },
        ],
      }
    },
  )

  // ─── Prompts ────────────────────────────────────────────────────

  server.prompt(
    'guren_review',
    'Review code changes against project conventions and patterns. Automatically fetches project context and runs integrity checks first.',
    async () => {
      let contextSummary: string
      try {
        const ctx = await cli.generateContext({ cwd })
        const check = await cli.runCheck({ cwd })
        contextSummary = [
          '## Project Context',
          `Framework: ${ctx.framework.name} v${ctx.framework.version}`,
          `Models: ${ctx.models.map((m) => m.className).join(', ') || 'none'}`,
          `Controllers: ${ctx.controllers.join(', ') || 'none'}`,
          `Pages: ${ctx.pages.join(', ') || 'none'}`,
          '',
          '## Integrity Check',
          `Pass: ${check.passCount}, Warn: ${check.warnCount}, Fail: ${check.failCount}`,
          ...check.checks
            .filter((c) => c.status !== 'pass')
            .map((c) => `- [${c.status}] ${c.title}: ${c.message}`),
        ].join('\n')
      } catch {
        contextSummary = 'Could not load project context.'
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                'Review the recent code changes in this Guren project.',
                'Check for:',
                '1. Adherence to project naming conventions and patterns',
                '2. Route-controller-page consistency',
                '3. Missing validation schemas',
                '4. Missing tests for new controllers',
                '5. Proper use of Model API (findOrFail, relationships)',
                '',
                contextSummary,
              ].join('\n'),
            },
          },
        ],
      }
    },
  )

  server.prompt(
    'guren_plan_feature',
    'Plan a new feature given the current project structure. Provide the feature description as an argument.',
    { feature: z.string().describe('Description of the feature to plan') },
    async ({ feature }) => {
      let contextSummary: string
      try {
        const ctx = await cli.generateContext({ cwd })
        const models = await cli.listModels({ appRoot: cwd })
        contextSummary = [
          '## Current Project State',
          `Models: ${models.map((m) => `${m.className}${m.tableName ? ` (${m.tableName})` : ''}`).join(', ') || 'none'}`,
          `Controllers: ${ctx.controllers.join(', ') || 'none'}`,
          `Routes: ${ctx.routes.length} defined`,
          `Pages: ${ctx.pages.join(', ') || 'none'}`,
          '',
          '## Model Relationships',
          ...models.flatMap((m) =>
            m.relationships.length > 0
              ? [
                  `${m.className}: ${m.relationships.map((r) => `${r.type}(${r.name})`).join(', ')}`,
                ]
              : [],
          ),
        ].join('\n')
      } catch {
        contextSummary = 'Could not load project context.'
      }

      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: [
                `Plan the implementation of: ${feature}`,
                '',
                'Provide:',
                '1. Which files to create/modify',
                '2. Database schema changes (migration)',
                '3. Model definition with relationships',
                '4. Controller actions and validation schemas',
                '5. Inertia page components',
                '6. Route definitions',
                '7. Test plan',
                '',
                contextSummary,
              ].join('\n'),
            },
          },
        ],
      }
    },
  )

  return server
}
