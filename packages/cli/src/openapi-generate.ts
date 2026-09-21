import { resolve } from 'node:path'
import { DEFAULT_ROUTES_FILE, loadRouteDefinitions } from './load-routes'
import { readIfExists } from './discovery'
import { resolveAppRoot, type WriterOptions } from './utils'

export interface GenerateOpenApiSpecOptions extends WriterOptions {
  routesFile?: string
  appRoot?: string
  outputFile?: string
  title?: string
  version?: string
  description?: string
  server?: string
}

export interface GenerateOpenApiSpecResult {
  outputPath: string
  warnings: string[]
}

type OpenApiModule = {
  writeOpenApiDocument(
    definitions: Awaited<ReturnType<typeof loadRouteDefinitions>>,
    options: {
      title: string
      version: string
      description?: string
      servers?: string[]
      appRoot?: string
      outputFile?: string
      force?: boolean
    },
  ): Promise<GenerateOpenApiSpecResult>
}

type PackageMetadata = {
  name?: string
  version?: string
  description?: string
}


export async function generateOpenApiSpec(
  options: GenerateOpenApiSpecOptions = {},
  dependencies: {
    importer?: () => Promise<OpenApiModule>
  } = {},
): Promise<GenerateOpenApiSpecResult> {
  const appRoot = resolveAppRoot(options)
  const routesFile = resolve(appRoot, options.routesFile ?? DEFAULT_ROUTES_FILE)
  const definitions = await loadRouteDefinitions(routesFile, appRoot)

  if (definitions.length === 0) {
    throw new Error('No routes were registered. Ensure your routes file exports a route registrar and registers routes with the provided router.')
  }

  const [packageMetadata, openapi] = await Promise.all([
    readPackageMetadata(appRoot),
    loadOpenApiModule(dependencies.importer),
  ])
  const info = resolveOpenApiInfo(options, packageMetadata)

  return openapi.writeOpenApiDocument(definitions, {
    title: info.title,
    version: info.version,
    description: info.description,
    servers: options.server ? [options.server] : undefined,
    appRoot,
    outputFile: options.outputFile,
    force: options.force,
  })
}

export async function loadOpenApiModule(
  importer: () => Promise<OpenApiModule> = defaultOpenApiImporter,
): Promise<OpenApiModule> {
  try {
    return await importer()
  } catch (error) {
    throw new Error(
      'OpenAPI support requires the optional `@guren/openapi` package. Install it in your app before running `guren openapi:generate`.',
      { cause: error },
    )
  }
}

export function resolveOpenApiInfo(
  options: Pick<GenerateOpenApiSpecOptions, 'title' | 'version' | 'description'>,
  packageMetadata: PackageMetadata = {},
): { title: string; version: string; description?: string } {
  return {
    title: options.title ?? packageMetadata.name ?? 'Guren API',
    version: options.version ?? packageMetadata.version ?? '1.0.0',
    description: options.description ?? packageMetadata.description,
  }
}

async function readPackageMetadata(appRoot: string): Promise<PackageMetadata> {
  const raw = await readIfExists(appRoot, 'package.json')
  return raw ? (JSON.parse(raw) as PackageMetadata) : {}
}

async function defaultOpenApiImporter(): Promise<OpenApiModule> {
  return import('@guren/openapi')
}
