import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8')
}

export async function auditStarterTemplate(root: string): Promise<void> {
  const packageJson = await read(root, 'package.json')
  assert(packageJson.includes('"@guren/core"'), 'Starter template must depend on @guren/core.')
  assert(!packageJson.includes('"@guren/server"'), 'Starter template must not depend directly on @guren/server.')
  assert(packageJson.includes('"dev": "bun run codegen && GUREN_MCP=1 bun run dev:server"'), 'Starter template must run codegen before dev.')
  assert(packageJson.includes('"dev:server": "bun --hot bin/serve.ts"'), 'Starter template must run the dev server with --hot so backend edits reload.')
  assert(packageJson.includes('"build": "bun run codegen && bunx vite build"'), 'Starter template must run codegen before build.')

  const appBootstrap = await read(root, 'src/app.ts')
  assert(appBootstrap.includes("import { createApp } from '@guren/core'"), 'Starter template must bootstrap with createApp from @guren/core.')
  assert(appBootstrap.includes('routes: registerWebRoutes'), 'Starter template must pass route registrar to createApp().')

  const mainEntry = await read(root, 'src/main.ts')
  assert(mainEntry.includes("from '@guren/core/runtime'"), 'Starter template must use @guren/core/runtime in src/main.ts.')

  assert(packageJson.includes('"console": "bun bin/console.ts"'), 'Starter template must expose a console script so generated commands are runnable.')
  const consoleEntry = await read(root, 'src/console.ts')
  assert(consoleEntry.includes('export const kernel = new ConsoleKernel('), 'Starter template must export the console kernel as `kernel` — the serverless recipes import it by that name.')
  const consoleRunner = await read(root, 'bin/console.ts')
  assert(consoleRunner.includes("import { kernel } from '../src/console.js'"), 'Starter template console runner must dispatch through src/console.ts.')
  assert(consoleRunner.includes('await ready'), 'Starter template console runner must boot the app before dispatching, or database-backed commands fail.')

  const viteConfig = await read(root, 'vite.config.ts')
  assert(viteConfig.includes("from '@guren/core/vite'"), 'Starter template must use @guren/core/vite.')
  assert(viteConfig.includes('publicDir: false'), 'Starter template must disable publicDir copying in Vite config.')

  const homePage = await read(root, 'resources/js/pages/Home.tsx')
  assert(homePage.includes('interface Props'), 'Starter template Home page must define Props interface.')

  const routes = await read(root, 'routes/web.ts')
  assert(routes.includes("from '@guren/core'"), 'Starter template routes must import from @guren/core.')
}

async function main(): Promise<void> {
  const root = resolve(process.argv[2] ?? 'packages/create-app/templates/default')
  await auditStarterTemplate(root)
  console.log(`Starter template audit passed for ${root}`)
}

if (import.meta.path === Bun.main) {
  await main()
}
