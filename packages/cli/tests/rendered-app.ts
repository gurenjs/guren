import { symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateApiClientTypes } from '../src/api-client-types'
import { generateDataTypes } from '../src/data-types'
import { generateFormTypes } from '../src/forms-types'
import { generatePageTypes } from '../src/pages-types'
import { generateRouteTypes } from '../src/routes-types'
import { linkWorkspacePackage } from './helpers'

const cliRoot = join(import.meta.dir, '..')

/**
 * Make a temp directory importable as an app before a generator runs in it. Bun resolves its `@/`
 * imports through the nearest tsconfig, and route codegen imports the routes file, so the rendered
 * controllers, models and validators evaluate for real and reach `@guren/core`, `@guren/orm` and
 * `zod`. Codegen writes forms.gen.ts only for an app depending on a client that exports ./forms.
 * Before the generator: a lookup that finds no node_modules can leave a later import unresolved.
 */
export async function prepareRenderedApp(dir: string): Promise<void> {
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }))
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'rendered-app', dependencies: { '@guren/inertia-client': 'workspace:*' } }))
  await linkWorkspacePackage('inertia-client', dir)
  await linkWorkspacePackage('core', dir)
  await linkWorkspacePackage('orm', dir)
  await symlink(join(cliRoot, 'node_modules/zod'), join(dir, 'node_modules/zod'), 'dir')
}

/** `guren codegen`'s route-dependent half, in its order: pages first, since the routes file's controllers import them. */
export async function runRouteCodegen(appRoot: string, routesFile = 'routes/web.ts'): Promise<void> {
  await generatePageTypes({ appRoot, extractProps: true, force: true })
  const { definitions } = await generateRouteTypes({ appRoot, routesFile, force: true })
  const { definitions: resources } = await generateDataTypes({ appRoot, force: true })
  await generateApiClientTypes(definitions, { appRoot, resources, force: true })
  await generateFormTypes(definitions, { appRoot, force: true })
}
