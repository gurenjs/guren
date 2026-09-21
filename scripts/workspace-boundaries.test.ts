import { expect, test } from 'bun:test'
import { parse } from '@babel/parser'
import { collectPackages, sortByDependencies } from './workspace-packages'
import { ATTACHMENT_DELIVERY_CONTROLLER_NAME, DEFAULT_DELIVERY_ROUTE_NAME } from '../packages/server/src/internal/app-conventions'
import { AttachmentDeliveryController, DEFAULT_DELIVERY_ROUTE_NAME as publicRouteName } from '../packages/core/src/attachments'

test('builds the runtime, CLI and public facade without ignoring cycles', async () => {
  const packages = await collectPackages()
  const ordered = sortByDependencies(packages).map((pkg) => pkg.name)
  expect(ordered.indexOf('@guren/server')).toBeLessThan(ordered.indexOf('@guren/cli'))
  expect(ordered.indexOf('@guren/cli')).toBeLessThan(ordered.indexOf('@guren/core'))
  const cli = packages.find((pkg) => pkg.name === '@guren/cli')!
  expect(cli.dependencies).not.toContain('@guren/core')
  const cyclic = packages.map((pkg) => pkg.name === '@guren/cli'
    ? { ...pkg, dependencies: [...pkg.dependencies, '@guren/core'] } : pkg)
  expect(() => sortByDependencies(cyclic)).toThrow('Dependency cycle')
})

test('CLI source imports runtime contracts without depending on its public facade', async () => {
  for await (const file of new Bun.Glob('packages/cli/src/**/*.ts').scan()) {
    const ast = parse(await Bun.file(file).text(), { sourceType: 'module', plugins: ['typescript'] })
    for (const node of ast.program.body) {
      if (node.type === 'ImportDeclaration') expect(node.source.value).not.toMatch(/^@guren\/core(?:\/|$)/)
    }
  }
})

test('the attachment route checker and runtime share the same registration names', () => {
  expect(AttachmentDeliveryController.name).toBe(ATTACHMENT_DELIVERY_CONTROLLER_NAME)
  expect(publicRouteName).toBe(DEFAULT_DELIVERY_ROUTE_NAME)
})
