import { consola } from 'consola'
import { defineCommand } from '../define-command'
import { toWriterOptions } from './scaffold-options'
import { runCodegen } from '../codegen'
import { generateRouteTypes } from '../routes-types'
import { describePageManifestSuppression, generatePageTypes, type PageManifestPlan } from '../pages-types'
import { generateOpenApiSpec } from '../openapi-generate'

/**
 * Says out loud that page components were found and deliberately not compiled
 * into a manifest: silently, a fullstack app misread as API-only would lose
 * `.guren/pages.gen.ts` with nothing on screen to explain it. `guren check` and
 * `guren doctor` report the same state for an unwatched run.
 */
function reportSuppressedPageManifest(plan: PageManifestPlan): void {
  const suppressed = describePageManifestSuppression(plan)
  if (!suppressed) return

  consola.warn(`${suppressed.message} ${suppressed.fix}`)
}

export const routeTypesCommand = defineCommand({
  meta: {
    name: 'routes:types',
    description: 'Generate TypeScript route declarations for client-side helpers.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the routes entry file',
      valueHint: 'routes/web.ts',
    },
    out: {
      type: 'string',
      description: 'Declaration file to write',
      valueHint: 'types/generated/routes.d.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory to resolve paths from',
      valueHint: '.',
    },
    pages: {
      type: 'string',
      description: 'Frontend pages directory to scan for page contracts',
      valueHint: 'resources/js/pages',
    },
    'pages-out': {
      type: 'string',
      description: 'Runtime page manifest module to write',
      valueHint: '.guren/pages.gen.ts',
    },
    // Opt-in, unlike check's: the Vite watcher runs codegen on every edit (RFC 0026 §5).
    introspect: {
      type: 'boolean',
      description: 'Take the route set from the introspected app, a provider\'s routes included (RFC 0026).',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const writerOptions = toWriterOptions(args)
    const { outputPath: pagesOutputPath, plan: pagesPlan } = await generatePageTypes({
      appRoot: args.app,
      pagesDir: args.pages,
      outputFile: args['pages-out'],
      ...writerOptions,
    })
    const { outputPath, runtimeOutputPath } = await generateRouteTypes({
      routesFile: args.routes,
      outputFile: args.out,
      appRoot: args.app,
      introspect: args.introspect === true,
      ...writerOptions,
    })
    if (pagesOutputPath) consola.success(`Page helpers generated at ${pagesOutputPath}`)
    reportSuppressedPageManifest(pagesPlan)
    consola.success(`Route types generated at ${outputPath}`)
    consola.success(`Route helpers generated at ${runtimeOutputPath}`)
  },
})

export const codegenCommand = defineCommand({
  meta: {
    name: 'codegen',
    description: 'Generate framework artifacts such as route declarations and runtime route helpers.',
  },
  args: routeTypesCommand.args,
  async run({ args }) {
    for await (const result of runCodegen({
      appRoot: args.app,
      routesFile: args.routes,
      outputFile: args.out,
      pagesDir: args.pages,
      pagesOutputFile: args['pages-out'],
      introspect: args.introspect === true,
    })) {
      switch (result.stage) {
        case 'supporting': {
          const { pagesOutputPath, pagesPlan, translationsOutputPath, keyCount, attachmentsOutputPath, attachableModels, attachmentWarnings } = result
          if (pagesOutputPath) consola.success(`Page helpers generated at ${pagesOutputPath}`)
          reportSuppressedPageManifest(pagesPlan)
          if (translationsOutputPath) {
            consola.success(`Translation keys generated at ${translationsOutputPath} (${keyCount} keys)`)
          }
          for (const warning of attachmentWarnings) {
            consola.warn(warning)
          }
          if (attachmentsOutputPath) {
            consola.success(
              `Attachment types generated at ${attachmentsOutputPath} (${attachableModels.length} ${attachableModels.length === 1 ? 'model' : 'models'})`,
            )
          }
          break
        }
        case 'data': {
          const { dataWarnings } = result
          for (const warning of dataWarnings) {
            consola.warn(warning)
          }
          break
        }
        case 'agents': {
          const { agentWarnings } = result
          for (const warning of agentWarnings) {
            consola.warn(warning)
          }
          break
        }
        case 'complete': {
          const {
            apiClientWarnings,
            outputPath,
            runtimeOutputPath,
            dataOutputPath,
            channelOutputPath,
            agentsOutputPath,
            agentTools,
            apiClientOutputPath,
          } = result
          for (const warning of apiClientWarnings) {
            consola.warn(warning)
          }
          consola.success(`Route types generated at ${outputPath}`)
          consola.success(`Route helpers generated at ${runtimeOutputPath}`)
          consola.success(`Data types generated at ${dataOutputPath}`)
          consola.success(`Channel types generated at ${channelOutputPath}`)
          if (agentsOutputPath) {
            consola.success(
              `Agent tools generated at ${agentsOutputPath} (${agentTools.length} ${agentTools.length === 1 ? 'tool' : 'tools'})`,
            )
          }
          consola.success(`API client generated at ${apiClientOutputPath}`)
          break
        }
        case 'missing-routes':
          consola.warn(`Routes file ${result.routesFile} not found — skipped route, data, channel, and API client generation.`)
          break
      }
    }
  },
})

export const openApiGenerateCommand = defineCommand({
  meta: {
    name: 'openapi:generate',
    description: 'Generate an OpenAPI 3.1 document using the optional @guren/openapi plugin.',
  },
  args: {
    routes: {
      type: 'string',
      description: 'Path to the route registration file',
      default: 'routes/web.ts',
    },
    app: {
      type: 'string',
      description: 'Application root directory',
      default: process.cwd(),
    },
    out: {
      type: 'string',
      description: 'Path to the generated OpenAPI document',
      default: '.guren/openapi.gen.json',
    },
    title: {
      type: 'string',
      description: 'OpenAPI document title. Defaults to package.json name or "Guren API".',
    },
    version: {
      type: 'string',
      description: 'OpenAPI document version. Defaults to package.json version or 1.0.0.',
    },
    description: {
      type: 'string',
      description: 'OpenAPI document description. Defaults to package.json description.',
    },
    server: {
      type: 'string',
      description: 'Server URL to include in the generated OpenAPI document.',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      alias: 'f',
    },
  },
  async run({ args }) {
    const { outputPath, warnings } = await generateOpenApiSpec({
      routesFile: args.routes,
      appRoot: args.app,
      outputFile: args.out,
      title: args.title,
      version: args.version,
      description: args.description,
      server: args.server,
      force: Boolean(args.force),
    })

    consola.success(`OpenAPI document generated at ${outputPath}`)
    for (const warning of warnings) {
      consola.warn(warning)
    }
  },
})
