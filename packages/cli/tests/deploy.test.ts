import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { scaffoldDeploy } from '../src/deploy'

describe('scaffoldDeploy', () => {
  let workspace: TempWorkspace

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-deploy-')
    await writeFile(join(workspace.dir, 'package.json'), JSON.stringify({ name: '@scope/my-guren-app' }, null, 2), 'utf8')
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  it('creates Docker recipe by default', async () => {
    const files = await scaffoldDeploy()
    expect(files).toHaveLength(1)
    expect(files.some((file) => file.endsWith('Dockerfile'))).toBe(true)

    const dockerfile = await readFile('Dockerfile', 'utf8')
    expect(dockerfile).toContain('FROM oven/bun:1 AS builder')
    expect(dockerfile).toContain('EXPOSE 3333')
  })

  it('creates Fly recipe with inferred app name and shared Dockerfile', async () => {
    const files = await scaffoldDeploy({ target: 'fly' })
    expect(files).toHaveLength(2)
    expect(files.some((file) => file.endsWith('Dockerfile'))).toBe(true)
    expect(files.some((file) => file.endsWith('fly.toml'))).toBe(true)

    const flyToml = await readFile('fly.toml', 'utf8')
    expect(flyToml).toContain('app = "scope-my-guren-app"')
    expect(flyToml).toContain('internal_port = 3333')
  })

  it('creates all provider recipe files with custom app and port', async () => {
    const files = await scaffoldDeploy({
      target: 'all',
      appName: 'My App',
      port: 4000,
    })

    expect(files).toHaveLength(3)
    expect(files.some((file) => file.endsWith('Dockerfile'))).toBe(true)
    expect(files.some((file) => file.endsWith('fly.toml'))).toBe(true)
    expect(files.some((file) => file.endsWith('railway.json'))).toBe(true)

    const dockerfile = await readFile('Dockerfile', 'utf8')
    expect(dockerfile).toContain('EXPOSE 4000')

    const flyToml = await readFile('fly.toml', 'utf8')
    expect(flyToml).toContain('app = "my-app"')
    expect(flyToml).toContain('internal_port = 4000')
    expect(flyToml).toContain('PORT = "4000"')
  })

  it('rejects invalid ports', async () => {
    await expect(scaffoldDeploy({ port: 0 })).rejects.toThrow('Port must be a positive integer.')
    await expect(scaffoldDeploy({ port: 3000.5 })).rejects.toThrow('Port must be a positive integer.')
  })
})
