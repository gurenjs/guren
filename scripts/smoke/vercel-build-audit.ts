/**
 * Verifies that the Vercel plugin's build reads a *real* Vite manifest and
 * injects the asset paths the function needs.
 *
 * The plugin's own tests build against synthetic fixtures, which cannot
 * catch the failure that matters here: Vite changing where or how it writes
 * manifests. When that happens the build still succeeds and the function
 * still boots — it just loses its asset paths, and Inertia silently falls
 * back to client-side rendering. Only a manifest produced by an actual Vite
 * build can prove the lookup still works.
 *
 * Usage: bun run ./scripts/smoke/vercel-build-audit.ts [appDir]
 * The app must already be built (`bun run --cwd <appDir> build`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { buildVercelOutput } from '../../packages/plugin-vercel/src/index'

interface FunctionConfig {
  handler?: string
  environment?: Record<string, string>
}

const appDir = resolve(process.argv[2] ?? 'examples/blog')
const clientManifest = resolve(appDir, 'public/assets/.vite/manifest.json')

if (!existsSync(clientManifest)) {
  console.error(
    `Vercel build audit: no client manifest at ${clientManifest}.\n` +
      `Build the app first: bun run --cwd ${process.argv[2] ?? 'examples/blog'} build`,
  )
  process.exit(1)
}

const outputDir = mkdtempSync(join(tmpdir(), 'guren-vercel-audit-'))

// The app under audit need not carry a Vercel entrypoint, and the one it
// would carry is not what this checks — manifest discovery reads the app
// root, not the entry. A trivial handler keeps the bundling step honest
// without asking every example app to adopt a deployment target.
const entrypoint = resolve(appDir, 'src/.vercel-audit-entry.ts')

try {
  writeFileSync(entrypoint, "export default { fetch: () => new Response('ok') }\n", 'utf8')

  buildVercelOutput({ rootDir: appDir, outputDir, entrypoint })

  const configPath = resolve(outputDir, 'functions/index.func/.vc-config.json')
  if (!existsSync(configPath)) {
    console.error(`Vercel build audit: the build produced no function config at ${configPath}.`)
    process.exit(1)
  }

  const config = JSON.parse(readFileSync(configPath, 'utf8')) as FunctionConfig
  const env = config.environment ?? {}
  const failures: string[] = []

  // The entry is the one value the browser cannot recover on its own: with it
  // empty, the page renders without ever loading the client bundle.
  if (!env.GUREN_INERTIA_ENTRY?.startsWith('/assets/')) {
    failures.push(
      `GUREN_INERTIA_ENTRY should point at a built asset, got ${JSON.stringify(env.GUREN_INERTIA_ENTRY)}. ` +
        'The client manifest exists, so the plugin failed to read it — check the paths it looks in.',
    )
  }

  const entryFile = env.GUREN_INERTIA_ENTRY?.replace('/assets/', '')
  if (entryFile && !existsSync(resolve(appDir, 'public/assets', entryFile))) {
    failures.push(`GUREN_INERTIA_ENTRY names ${entryFile}, which does not exist in the build output.`)
  }

  if (!config.handler) {
    failures.push('The function config has no handler.')
  }

  if (failures.length > 0) {
    console.error('Vercel build audit failed:')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exit(1)
  }

  console.log(`Vercel build audit passed for ${appDir}`)
  console.log(`  handler: ${config.handler}`)
  console.log(`  GUREN_INERTIA_ENTRY: ${env.GUREN_INERTIA_ENTRY}`)
  if (env.GUREN_INERTIA_STYLES) {
    console.log(`  GUREN_INERTIA_STYLES: ${env.GUREN_INERTIA_STYLES}`)
  }
} finally {
  rmSync(entrypoint, { force: true })
  rmSync(outputDir, { recursive: true, force: true })
}
