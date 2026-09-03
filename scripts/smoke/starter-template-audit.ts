import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { getAppBlueprint, listAppBlueprints, listBlueprintTemplates } from '../../packages/create-app/src/blueprints'
import { directoryExists } from '../../packages/create-app/src/utils'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message)
  }
}

async function read(root: string, relativePath: string): Promise<string> {
  return readFile(join(root, relativePath), 'utf8')
}

/**
 * `create-guren-app` publishes only the directories in its `files` field, so a
 * template the registry names but the tarball omits is invisible in-repo (how
 * the `blog` blueprint shipped broken). The registry is read from source, since
 * importing the packed bundle would run its `runMain()`.
 *
 * @param root The extracted `package/` directory of a create-guren-app tarball.
 */
export async function auditBlueprintTemplates(root: string): Promise<void> {
  const bundle = await readFile(join(root, 'dist/cli.js'), 'utf8')

  for (const blueprint of listAppBlueprints()) {
    const templates = listBlueprintTemplates(getAppBlueprint(blueprint))
    assert(templates.length > 0, `Blueprint "${blueprint}" declares no template.`)

    for (const template of templates) {
      assert(
        await directoryExists(join(root, 'templates', template)),
        `Blueprint "${blueprint}" needs template "${template}", which is missing from the create-guren-app tarball.`,
      )
      assert(
        bundle.includes(`"${template}"`) || bundle.includes(`'${template}'`),
        `The packed create-guren-app dist/ never names the "${template}" template that blueprint "${blueprint}" declares in src — the tarball was built from stale sources.`,
      )
    }
  }

  // npm keeps dot-directories under `files` entries, unlike files literally
  // named `.gitignore`, which it strips (hence the `_gitignore` convention).
  for (const template of ['default', 'api-only']) {
    const contents = await read(root, `templates/${template}/.github/workflows/ci.yml`).catch(() => '')
    assert(
      contents.includes('guren check --ci'),
      `templates/${template}/.github/workflows/ci.yml is missing from the create-guren-app tarball (or lost its check gate).`,
    )
  }
}

/**
 * Audited separately because `auditStarterTemplate` covers the default
 * template's Vite and React files, which the API-only template does not have.
 */
export async function auditConsoleWiring(root: string): Promise<void> {
  const packageJson = await read(root, 'package.json')
  assert(packageJson.includes('"console": "bun bin/console.ts"'), `${root} must expose a console script so generated commands are runnable.`)

  const consoleEntry = await read(root, 'src/console.ts')
  assert(consoleEntry.includes('export const kernel ='), `${root} must export the console kernel as \`kernel\` — the serverless recipes import it by that name.`)

  const consoleRunner = await read(root, 'bin/console.ts')
  assert(consoleRunner.includes("import { kernel } from '../src/console.js'"), `${root} console runner must dispatch through src/console.ts.`)
  assert(consoleRunner.includes('await ready'), `${root} console runner must boot the app before dispatching, or database-backed commands fail.`)
}

export async function auditStarterTemplate(root: string): Promise<void> {
  const packageJson = await read(root, 'package.json')
  assert(packageJson.includes('"@guren/core"'), 'Starter template must depend on @guren/core.')
  assert(!packageJson.includes('"@guren/server"'), 'Starter template must not depend directly on @guren/server.')
  assert(packageJson.includes('"dev": "bun run codegen && GUREN_MCP=1 GUREN_DOCS=1 bun run dev:server"'), 'Starter template must run codegen before dev, with the dev-only MCP endpoint and docs viewer enabled.')
  assert(packageJson.includes('"dev:server": "bun --hot bin/serve.ts"'), 'Starter template must run the dev server with --hot so backend edits reload.')
  assert(packageJson.includes('"build": "bun run codegen && bunx vite build"'), 'Starter template must run codegen before build.')

  const appBootstrap = await read(root, 'src/app.ts')
  assert(appBootstrap.includes("import { createApp } from '@guren/core'"), 'Starter template must bootstrap with createApp from @guren/core.')
  assert(appBootstrap.includes('routes: registerWebRoutes'), 'Starter template must pass route registrar to createApp().')

  const mainEntry = await read(root, 'src/main.ts')
  assert(mainEntry.includes("from '@guren/core/runtime'"), 'Starter template must use @guren/core/runtime in src/main.ts.')

  await auditConsoleWiring(root)

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

  if (process.argv[2] === undefined) {
    const apiRoot = resolve('packages/create-app/templates/api-only')
    await auditConsoleWiring(apiRoot)
    console.log(`Console wiring audit passed for ${apiRoot}`)
  }
}

if (import.meta.path === Bun.main) {
  await main()
}
