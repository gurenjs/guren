import { generateRouteTypes } from './routes-types'
import { generateTranslationTypes } from './i18n-types'
import { generateDataTypes } from './data-types'
import { generateAttachmentTypes } from './attachments-types'
import { generateApiClientTypes } from './api-client-types'
import { generateAgentTypes } from './agents-types'
import { generateChannelTypes } from './channel-types'
import { generatePageTypes } from './pages-types'
import type { WriterOptions } from './utils'

export interface CodegenOptions {
  appRoot?: string
  routesFile?: string
  outputFile?: string
  pagesDir?: string
  pagesOutputFile?: string
  introspect?: boolean
}

// Yield completed stages so the CLI can report progress before a later stage
// fails, while generation order and data dependencies stay independent of it.
export async function* runCodegen(options: CodegenOptions) {
  // codegen's outputs are entirely generated artifacts, safe to overwrite by
  // default — including custom --out/--pages-out destinations. --force is
  // accepted for backward compatibility but is a no-op.
  const writerOptions: WriterOptions = { force: true }
  // These three read disjoint inputs (pages, lang/, app/Models) and write
  // disjoint artifacts, so they run concurrently.
  const [
    { outputPath: pagesOutputPath, plan: pagesPlan },
    { outputPath: translationsOutputPath, keyCount },
    { outputPath: attachmentsOutputPath, models: attachableModels, warnings: attachmentWarnings },
  ] = await Promise.all([
    generatePageTypes({
      appRoot: options.appRoot,
      pagesDir: options.pagesDir,
      outputFile: options.pagesOutputFile,
      extractProps: true,
      ...writerOptions,
    }),
    generateTranslationTypes({ appRoot: options.appRoot, ...writerOptions }),
    generateAttachmentTypes({ appRoot: options.appRoot, ...writerOptions }),
  ])
  yield {
    stage: 'supporting' as const,
    pagesOutputPath,
    pagesPlan,
    translationsOutputPath,
    keyCount,
    attachmentsOutputPath,
    attachableModels,
    attachmentWarnings,
  }

  // Route/API artifacts default to routes/web.ts; skip only when no routes file exists.
  const { existsSync } = await import('node:fs')
  const { resolve: resolvePath } = await import('node:path')
  const routesFile = options.routesFile ?? 'routes/web.ts'
  const appRoot = options.appRoot ?? process.cwd()
  if (!existsSync(resolvePath(appRoot, routesFile))) {
    yield { stage: 'missing-routes' as const, routesFile }
    return
  }

  const { outputPath, runtimeOutputPath, definitions } = await generateRouteTypes({
    routesFile,
    outputFile: options.outputFile,
    appRoot: options.appRoot,
    introspect: options.introspect,
    ...writerOptions,
  })
  const {
    outputPath: dataOutputPath,
    definitions: resourceDefinitions,
    warnings: dataWarnings,
  } = await generateDataTypes({
    appRoot: options.appRoot,
    ...writerOptions,
  })
  yield { stage: 'data' as const, dataWarnings }
  const { outputPath: channelOutputPath } = await generateChannelTypes({
    appRoot: options.appRoot,
    ...writerOptions,
  })
  // Agent tools sit between data and the API client: they consume the Resource
  // definitions the data generator produced, and the `Data` import they emit
  // resolves against the sibling data.gen.ts.
  const {
    outputPath: agentsOutputPath,
    tools: agentTools,
    warnings: agentWarnings,
  } = await generateAgentTypes(definitions, {
    appRoot: options.appRoot,
    resources: resourceDefinitions,
    ...writerOptions,
  })
  yield { stage: 'agents' as const, agentWarnings }
  const { outputPath: apiClientOutputPath, warnings: apiClientWarnings } = await generateApiClientTypes(
    definitions,
    { appRoot: options.appRoot, resources: resourceDefinitions, ...writerOptions },
  )
  yield {
    stage: 'complete' as const,
    apiClientWarnings,
    outputPath,
    runtimeOutputPath,
    dataOutputPath,
    channelOutputPath,
    agentsOutputPath,
    agentTools,
    apiClientOutputPath,
  }
}
