import { expect, test } from 'bun:test'
import { collectPackages, repoRoot, sortByDependencies } from './workspace-packages'
import { groupRequirements } from './sync-import-floors'
import { ATTACHMENT_DELIVERY_CONTROLLER_NAME, DEFAULT_DELIVERY_ROUTE_NAME } from '../packages/cli/src/attachments-check'
import { AttachmentDeliveryController, DEFAULT_DELIVERY_ROUTE_NAME as publicRouteName } from '../packages/core/src/attachments'

test('builds the runtime, CLI and public facade without ignoring cycles', async () => {
  const packages = await collectPackages()
  const ordered = sortByDependencies(packages).map((pkg) => pkg.name)
  const position = (name: string) => ordered.indexOf(name)
  expect(position('@guren/server')).toBeLessThan(position('@guren/cli'))
  expect(position('@guren/cli')).toBeLessThan(position('@guren/core'))
  // Soft edges still order what they can: testing's declarations read core's and plugin-ai's.
  expect(position('@guren/core')).toBeLessThan(position('@guren/testing'))
  expect(position('@guren/plugin-ai')).toBeLessThan(position('@guren/testing'))
  const cli = packages.find((pkg) => pkg.name === '@guren/cli')!
  expect(cli.dependencies).not.toContain('@guren/core')
  const cyclic = packages.map((pkg) => pkg.name === '@guren/cli'
    ? { ...pkg, dependencies: [...pkg.dependencies, '@guren/core'] } : pkg)
  expect(() => sortByDependencies(cyclic)).toThrow('Dependency cycle')
})

test('CLI source imports runtime contracts without depending on its public facade', async () => {
  const paths = await Array.fromAsync(new Bun.Glob('src/**/*.ts').scan({ cwd: `${repoRoot}/packages/cli` }))
  expect(paths.length).toBeGreaterThan(0)
  const files = await Promise.all(paths.map(async (path) => ({ path, source: await Bun.file(`${repoRoot}/packages/cli/${path}`).text() })))
  // Every import form, `export … from` and `import()` included, not only import declarations.
  expect([...groupRequirements('@guren/cli', files).keys()]).not.toContain('@guren/core')
})

test('the attachment route checker and runtime share the same registration names', () => {
  expect(AttachmentDeliveryController.name).toBe(ATTACHMENT_DELIVERY_CONTROLLER_NAME)
  expect(publicRouteName).toBe(DEFAULT_DELIVERY_ROUTE_NAME)
})
