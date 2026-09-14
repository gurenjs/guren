import { beforeEach, afterEach, describe, expect, it } from 'bun:test'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTempWorkspace, type TempWorkspace } from './helpers'
import { DOCKER_RUNTIME_DIRECTORIES, DOCKER_RUNTIME_FILES, scaffoldDeploy, scaffoldDeployReport } from '../src/deploy'

const createAppTemplates = join(import.meta.dir, '../../create-app/templates')

// A template entry absent from both this map and the runtime lists fails the
// copy test: that is how `lang/` and `tsconfig.json` went missing from the image.
const NOT_IN_PRODUCTION_IMAGE: Record<string, string> = {
  'package.json': 'copied on its own, with bun.lock, ahead of the production install',
  '.env.example': 'the container takes its environment at run time',
  _gitignore: 'git only',
  '.github': 'CI only',
  '.oxlintrc.json': 'lint only',
  'README.md': 'documentation',
  docs: 'the docs viewer never mounts under NODE_ENV=production',
  resources: 'compiled into public/assets (and .guren/ssr) by the build',
  types: 'type declarations only',
  tests: 'test only',
  'vite.config.ts': 'build only',
  'drizzle.config.ts': 'drizzle-kit only; the app applies db/migrations itself',
}

async function templateTopLevelEntries(): Promise<Set<string>> {
  // `database/` holds one template per driver rather than an app tree.
  const roots: string[] = []
  for (const name of await readdir(createAppTemplates)) {
    if (name !== 'database') {
      roots.push(join(createAppTemplates, name))
    }
  }
  for (const driver of await readdir(join(createAppTemplates, 'database'))) {
    roots.push(join(createAppTemplates, 'database', driver))
  }
  const entries = new Set<string>()
  for (const root of roots) {
    for (const entry of await readdir(root)) {
      entries.add(entry)
    }
  }
  return entries
}

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

  it('reports no overwrites on a fresh app', async () => {
    const { files, overwritten } = await scaffoldDeployReport({ target: 'all' })

    expect(files).toHaveLength(3)
    expect(overwritten).toEqual([])
  })

  it('names the recipes --force overwrote and not the ones it created', async () => {
    await writeFile('Dockerfile', 'FROM scratch\n', 'utf8')

    const { files, overwritten } = await scaffoldDeployReport({ target: 'all', force: true })

    expect(files).toHaveLength(3)
    expect(overwritten).toHaveLength(1)
    expect(overwritten[0]!.endsWith('Dockerfile')).toBe(true)
    expect(await readFile('Dockerfile', 'utf8')).toContain('FROM oven/bun:1 AS builder')
  })

  it('copies every runtime entry the create-app templates ship into the production image', async () => {
    await scaffoldDeploy()
    const dockerfile = await readFile('Dockerfile', 'utf8')
    const copied = new Set(
      [...dockerfile.matchAll(/^COPY --from=builder \/app\/(\S+) \.\/\1$/gmu)].map((match) => match[1]),
    )
    const runtimeEntries = new Set<string>([...DOCKER_RUNTIME_FILES, ...DOCKER_RUNTIME_DIRECTORIES])

    const unclassified: string[] = []
    const seenExclusions = new Set<string>()
    for (const entry of await templateTopLevelEntries()) {
      if (entry in NOT_IN_PRODUCTION_IMAGE) {
        seenExclusions.add(entry)
      } else if (!runtimeEntries.has(entry)) {
        unclassified.push(entry)
      }
    }

    expect(unclassified).toEqual([])
    expect(Object.keys(NOT_IN_PRODUCTION_IMAGE).filter((entry) => !seenExclusions.has(entry))).toEqual([])
    expect([...copied].sort()).toEqual([...runtimeEntries].sort())
    expect(dockerfile).toContain('COPY --from=builder /app/package.json /app/bun.lock ./')
  })

  it('creates every runtime directory in the builder so a COPY never names a missing source', async () => {
    await scaffoldDeploy()
    const dockerfile = await readFile('Dockerfile', 'utf8')
    const builderStage = dockerfile.slice(0, dockerfile.indexOf('# Production stage'))
    const mkdir = builderStage.match(/^RUN mkdir -p (.+)$/mu)

    expect(mkdir).not.toBeNull()
    expect(mkdir![1].split(' ').sort()).toEqual([...DOCKER_RUNTIME_DIRECTORIES].sort())
  })

  it('rejects invalid ports', async () => {
    await expect(scaffoldDeploy({ port: 0 })).rejects.toThrow('Port must be a positive integer.')
    await expect(scaffoldDeploy({ port: 3000.5 })).rejects.toThrow('Port must be a positive integer.')
  })
})
