import { cp, readFile, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toPackageName, toTitleCase } from './utils'

export const APP_BLUEPRINTS = ['default', 'blog'] as const
export type AppBlueprintName = (typeof APP_BLUEPRINTS)[number]
export type RenderingMode = 'spa' | 'ssr'

interface TemplateLayer {
  dir: string
  excludePaths?: string[]
}

interface BlueprintContext {
  appName: string
  appTitle: string
  destination: string
  packageName: string
  renderingMode: RenderingMode
}

export interface AppBlueprint {
  name: AppBlueprintName
  description: string
  baseTemplate: TemplateLayer
  overlayTemplateDirs: Partial<Record<RenderingMode, TemplateLayer[]>>
  transformFiles: string[]
  replacements?: (context: BlueprintContext) => Map<string, string>
  postScaffold?: (context: BlueprintContext) => Promise<void>
}

export interface ScaffoldAppBlueprintOptions {
  blueprint?: string
  destination: string
  renderingMode: RenderingMode
}

const DEFAULT_TRANSFORM_FILES = [
  'CLAUDE.md',
  'README.md',
  'package.json',
  'public/index.html',
  'bin/serve.ts',
  'app/Http/Controllers/HomeController.ts',
  'resources/js/pages/Home.tsx',
]

const BLOG_TRANSFORM_FILES = [
  'README.md',
  'public/index.html',
  'app/Providers/EventServiceProvider.ts',
  'app/Http/Controllers/Auth/LoginController.ts',
  'app/Http/Controllers/DashboardController.ts',
  'app/Http/Controllers/PostController.ts',
  'app/Http/Controllers/ProfileController.ts',
  'resources/js/components/Layout.tsx',
]

const BLOG_OVERLAY_EXCLUDES = [
  '.env',
  '.guren',
  'AGENTS.md',
  'node_modules',
  'package.json',
  'public/assets',
  'tests',
  'tsconfig.json',
  'types/generated',
  'vitest.config.ts',
]

const defaultTemplateDir = fileURLToPath(new URL('../templates/default', import.meta.url))
const defaultSsrOverlayDir = fileURLToPath(new URL('../templates/default-ssr', import.meta.url))
const exampleBlogDir = fileURLToPath(new URL('../../../examples/blog', import.meta.url))

const blueprintRegistry: Record<AppBlueprintName, AppBlueprint> = {
  default: {
    name: 'default',
    description: 'The standard Guren starter blueprint.',
    baseTemplate: {
      dir: defaultTemplateDir,
    },
    overlayTemplateDirs: {
      ssr: [{ dir: defaultSsrOverlayDir }],
    },
    transformFiles: DEFAULT_TRANSFORM_FILES,
  },
  blog: {
    name: 'blog',
    description: 'The canonical blog-style starter used by the examples workspace.',
    baseTemplate: {
      dir: defaultTemplateDir,
    },
    overlayTemplateDirs: {
      spa: [{ dir: exampleBlogDir, excludePaths: BLOG_OVERLAY_EXCLUDES }],
      ssr: [{ dir: exampleBlogDir, excludePaths: BLOG_OVERLAY_EXCLUDES }],
    },
    transformFiles: [...new Set([...DEFAULT_TRANSFORM_FILES, ...BLOG_TRANSFORM_FILES])],
    replacements: ({ appTitle, packageName }) => new Map<string, string>([
      ['@guren/example-blog', packageName],
      ['Guren Blog Example', `${appTitle} Example`],
      ['Guren Blog', appTitle],
      ['blog.example.com', `${packageName}.example.com`],
    ]),
    postScaffold: async ({ destination, renderingMode }) => {
      const packageJsonPath = join(destination, 'package.json')
      const rawPackage = await readFile(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(rawPackage) as {
        scripts?: Record<string, string>
        dependencies?: Record<string, string>
      }

      packageJson.scripts ??= {}
      packageJson.dependencies ??= {}

      const gurenVersion =
        packageJson.dependencies['@guren/core'] ??
        packageJson.dependencies['@guren/server'] ??
        packageJson.dependencies['@guren/orm'] ??
        '^0.2.0-alpha.7'

      packageJson.scripts.typecheck ??= 'tsc --noEmit'
      packageJson.scripts.smoke ??= 'bun run ./smoke.ts'
      packageJson.dependencies['@guren/core'] ??= gurenVersion
      packageJson.dependencies['@inertiajs/core'] ??= '^2.2.15'
      packageJson.dependencies['lucide-react'] ??= '^0.552.0'
      packageJson.dependencies.zod ??= '^4.1.5'

      await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8')

      if (renderingMode === 'spa') {
        const mainPath = join(destination, 'src/main.ts')
        const mainSource = await readFile(mainPath, 'utf8')
        if (!mainSource.includes('enableSsr: false')) {
          const updated = mainSource.replace(
            'autoConfigureInertiaAssets(app, {\n  importMeta: import.meta,\n})',
            'autoConfigureInertiaAssets(app, {\n  importMeta: import.meta,\n  enableSsr: false,\n})',
          )
          await writeFile(mainPath, updated, 'utf8')
        }
      }
    },
  },
}

function replaceTokens(content: string, tokens: Map<string, string>): string {
  let updated = content
  for (const [token, replacement] of tokens) {
    updated = updated.split(token).join(replacement)
  }
  return updated
}

async function copyTemplate(template: string, destination: string): Promise<void> {
  await cp(template, destination, { recursive: true, force: true })
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+$/u, '')
}

function shouldExclude(templateRoot: string, sourcePath: string, excludePaths: string[] = []): boolean {
  const relativePath = normalizePath(relative(templateRoot, sourcePath))

  if (relativePath === '' || relativePath === '.') {
    return false
  }

  return excludePaths.some((candidate) => {
    const normalizedCandidate = normalizePath(candidate)
    return relativePath === normalizedCandidate || relativePath.startsWith(`${normalizedCandidate}/`)
  })
}

async function copyLayer(layer: TemplateLayer, destination: string): Promise<void> {
  await cp(layer.dir, destination, {
    recursive: true,
    force: true,
    filter: (sourcePath) => !shouldExclude(layer.dir, sourcePath, layer.excludePaths),
  })
}

async function applyTokenTransforms(destination: string, files: string[], tokens: Map<string, string>): Promise<void> {
  for (const file of files) {
    const path = join(destination, file)
    const content = await readFile(path, 'utf8')
    const updated = replaceTokens(content, tokens)
    if (updated !== content) {
      await writeFile(path, updated, 'utf8')
    }
  }
}

export function listAppBlueprints(): AppBlueprintName[] {
  return [...APP_BLUEPRINTS]
}

export function getAppBlueprint(name: string | undefined): AppBlueprint {
  const blueprintName = (name ?? 'default') as AppBlueprintName
  const blueprint = blueprintRegistry[blueprintName]
  if (!blueprint) {
    throw new Error(`Unknown blueprint "${name}". Available blueprints: ${listAppBlueprints().join(', ')}`)
  }
  return blueprint
}

export async function scaffoldAppBlueprint(options: ScaffoldAppBlueprintOptions): Promise<AppBlueprint> {
  const blueprint = getAppBlueprint(options.blueprint)
  const appName = basename(options.destination)
  const packageName = toPackageName(appName)
  const appTitle = toTitleCase(appName)
  const context: BlueprintContext = {
    appName,
    appTitle,
    destination: options.destination,
    packageName,
    renderingMode: options.renderingMode,
  }
  const tokenMap = new Map<string, string>([
    ['guren-app-placeholder', packageName],
    ['__APP_TITLE__', appTitle],
    ['__APP_NAME__', appName],
  ])

  for (const [token, replacement] of blueprint.replacements?.(context) ?? []) {
    tokenMap.set(token, replacement)
  }

  await copyLayer(blueprint.baseTemplate, options.destination)

  for (const overlay of blueprint.overlayTemplateDirs[options.renderingMode] ?? []) {
    await copyLayer(overlay, options.destination)
  }

  await applyTokenTransforms(options.destination, blueprint.transformFiles, tokenMap)
  await blueprint.postScaffold?.(context)
  return blueprint
}
