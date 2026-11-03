import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderDepsWhy } from '../src/commands/deps'
import { dependencyTree, readBunLock, type BunLock } from '../src/dependency-tree'
import { loadDependencyTree } from '../src/dependency-tree-load'
import { CLI_BIN_PATH } from './helpers'

const SHA = (seed: string) => `sha512-${seed}==`

/** A lockfile shaped as Bun 1.4.4 writes a new one: version 2, trailing commas, nested copies keyed `parent/child`. */
const LOCK_TEXT = `{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {
    "": {
      "name": "app",
      "dependencies": { "@guren/core": "^1.26.0", "old-consumer": "^1.0.0" },
      "devDependencies": { "test-tool": "^2.0.0" },
      "optionalDependencies": { "fsevents": "^2.3.0" },
    },
  },
  "packages": {
    "@guren/core": ["@guren/core@1.26.0", "", { "dependencies": { "@guren/server": "^2.35.0" } }, "${SHA('core')}"],
    "@guren/server": ["@guren/server@2.35.0", "", { "dependencies": { "hono": "^4.13.0" }, "peerDependencies": { "react": "^19" } }, "${SHA('server')}"],
    "hono": ["hono@4.13.13", "", {}, "${SHA('hono-new')}"],
    "old-consumer": ["old-consumer@1.0.0", "", { "dependencies": { "hono": "^3.0.0" } }, "${SHA('old')}"],
    "old-consumer/hono": ["hono@3.12.0", "", {}, "${SHA('hono-old')}"],
    "test-tool": ["test-tool@2.1.0", "", { "dependencies": { "@scope/helper": "^1.0.0" } }, "${SHA('tool')}"],
    "@scope/helper": ["@scope/helper@1.0.0", "", { "dependencies": { "hono": "^4.0.0" } }, "${SHA('helper')}"],
  },
}
`

function readLock(text = LOCK_TEXT): BunLock {
  const reading = readBunLock(text)
  if (reading.kind !== 'read') throw new Error(reading.reason)
  return reading.lock
}

describe('readBunLock', () => {
  it('reports a lockfile that does not parse', () => {
    expect(readBunLock('{ "lockfileVersion": ').kind).toBe('unreadable')
  })

  it('reports a lockfile version it does not know', () => {
    const reading = readBunLock('{ "lockfileVersion": 9, "workspaces": {}, "packages": {} }')

    expect(reading).toEqual({ kind: 'unreadable', reason: 'bun.lock has lockfileVersion 9, which this reader does not know' })
    expect(readBunLock('{ "lockfileVersion": 0, "workspaces": {}, "packages": {} }').kind).toBe('unreadable')
  })

  it('reads a version 1 lockfile, which older installs wrote', () => {
    expect(readBunLock(LOCK_TEXT.replace('"lockfileVersion": 2', '"lockfileVersion": 1')).kind).toBe('read')
  })
})

describe('dependencyTree', () => {
  it('lists each installed version of a package once, with its path from every direct dependency', () => {
    const tree = dependencyTree(readLock())
    const hono = tree.packages.filter((instance) => instance.name === 'hono')

    expect(tree.coverage).toEqual({ status: 'complete', reasons: [] })
    expect(hono.map((instance) => instance.id)).toEqual(['hono@3.12.0', 'hono@4.13.13'])
    expect(hono[0]!.paths).toEqual({ 'old-consumer': ['old-consumer', 'hono'] })
    expect(hono[1]!.paths).toEqual({
      '@guren/core': ['@guren/core', '@guren/server', 'hono'],
      'test-tool': ['test-tool', '@scope/helper', 'hono'],
    })
    expect(hono[1]!.depth).toBe(2)
    expect(hono[1]!.integrity).toBe(SHA('hono-new'))
  })

  it('tells what a production install leaves out from what it installs', () => {
    const byId = new Map(dependencyTree(readLock()).packages.map((instance) => [instance.id, instance]))

    expect(byId.get('test-tool@2.1.0')).toMatchObject({ direct: true, depth: 0, declaredAs: ['dev'], installedInProduction: false })
    expect(byId.get('@scope/helper@1.0.0')?.installedInProduction).toBe(false)
    expect(byId.get('hono@4.13.13')?.installedInProduction).toBe(true)
    expect(byId.get('@guren/core@1.26.0')?.declaredAs).toEqual(['prod'])
  })

  it('skips a missing optional dependency or peer, and reports a missing dependency as a gap', () => {
    const lock = readLock()
    delete lock.packages['@scope/helper']

    const tree = dependencyTree(lock)

    expect(tree.coverage).toEqual({
      status: 'partial',
      reasons: [{ code: 'unresolved', message: 'test-tool@2.1.0 depends on @scope/helper, which has no entry in bun.lock.' }],
    })
  })

  it('resolves a nested copy under a scoped parent before the hoisted one', () => {
    const lock = readLock()
    lock.packages['@scope/helper/hono'] = ['hono@4.0.1', '', {}, SHA('nested')]

    const instance = dependencyTree(lock).packages.find((entry) => entry.id === 'hono@4.0.1')

    expect(instance?.paths).toEqual({ 'test-tool': ['test-tool', '@scope/helper', 'hono'] })
  })

  it('reads a workspace package from its workspaces entry, for an app inside a monorepo', () => {
    const lock = readLock(`{
      "lockfileVersion": 1,
      "workspaces": {
        "": { "name": "repo" },
        "apps/web": { "name": "web", "dependencies": { "shared": "workspace:*" } },
        "packages/shared": { "name": "shared", "dependencies": { "hono": "^4.13.0" }, "devDependencies": { "test-tool": "^2.0.0" } },
      },
      "packages": {
        "shared": ["shared@workspace:packages/shared"],
        "hono": ["hono@4.13.13", "", {}, "${SHA('hono')}"],
      },
    }`)

    const tree = dependencyTree(lock, 'apps/web')

    expect(tree.coverage.status).toBe('complete')
    expect(tree.packages.map((instance) => instance.id)).toEqual(['hono@4.13.13', 'shared@workspace:packages/shared'])
  })

  it('is unavailable for a workspace the lockfile does not have, naming the lockfile', () => {
    const tree = dependencyTree(readLock(), 'apps/missing', '../bun.lock')

    expect(tree.coverage).toEqual({ status: 'unavailable', reasons: [{ code: 'no-workspace', message: '../bun.lock has no workspace "apps/missing".' }] })
  })

  it('reads the nested copies a workspace app owns under its package name, before the hoisted ones', () => {
    const lock = readLock(`{
      "lockfileVersion": 2,
      "workspaces": {
        "": { "name": "repo", "devDependencies": { "vitest": "^5.0.0" } },
        "packages/plugin": { "name": "@scope/plugin", "devDependencies": { "vitest": "^4.1.0" } },
      },
      "packages": {
        "@scope/plugin": ["@scope/plugin@workspace:packages/plugin"],
        "vitest": ["vitest@5.0.5", "", {}, "${SHA('v5')}"],
        "@scope/plugin/vitest": ["vitest@4.1.12", "", { "dependencies": { "pathe": "^2.0.0" } }, "${SHA('v4')}"],
        "@scope/plugin/vitest/pathe": ["pathe@2.0.3", "", {}, "${SHA('pathe')}"],
      },
    }`)

    const tree = dependencyTree(lock, 'packages/plugin')

    expect(tree.packages.map((instance) => instance.id)).toEqual(['pathe@2.0.3', 'vitest@4.1.12'])
    expect(tree.packages[1]).toMatchObject({ direct: true, declaredAs: ['dev'] })
  })

  it('falls back from a/b/c to a/c, then to the hoisted c', () => {
    const lock = readLock()
    lock.packages['test-tool/@scope/helper'] = ['@scope/helper@1.1.0', '', { dependencies: { hono: '^4.0.0', extra: '^1.0.0' } }, SHA('helper-nested')]
    lock.packages['test-tool/hono'] = ['hono@4.1.0', '', {}, SHA('hono-mid')]
    lock.packages.extra = ['extra@1.0.0', '', {}, SHA('extra')]

    const ids = dependencyTree(lock).packages.filter((instance) => instance.paths['test-tool']).map((instance) => instance.id)

    expect(ids).toEqual(['@scope/helper@1.1.0', 'extra@1.0.0', 'hono@4.1.0', 'test-tool@2.1.0'])
  })

  it('records an npm alias under the name it is installed as', () => {
    const lock = readLock()
    lock.workspaces['']!.dependencies!['str'] = 'npm:string-width@4.2.3'
    lock.packages.str = ['string-width@4.2.3', '', {}, SHA('sw')]

    const instance = dependencyTree(lock).packages.find((entry) => entry.name === 'string-width')

    expect(instance).toMatchObject({ installedAs: ['str'], direct: true, paths: { str: ['str'] } })
  })

  it('reports a workspace package whose workspaces entry is missing', () => {
    const lock = readLock()
    lock.workspaces['']!.dependencies!['shared'] = 'workspace:*'
    lock.packages.shared = ['shared@workspace:packages/shared']

    expect(dependencyTree(lock).coverage.reasons.map((reason) => reason.code)).toEqual(['unreadable-entry'])
  })
})

describe('loadDependencyTree and deps:why', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-deps-why-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('finds the lockfile above an app inside a monorepo', async () => {
    await writeFile(join(root, 'bun.lock'), LOCK_TEXT.replace('"": {', '"": { "name": "repo" },\n    "apps/web": {'), 'utf8')
    await mkdir(join(root, 'apps', 'web'), { recursive: true })

    const tree = await loadDependencyTree(join(root, 'apps', 'web'))

    expect(tree).toMatchObject({ lockfile: '../../bun.lock', workspace: 'apps/web', coverage: { status: 'complete' } })
  })

  it('is unavailable with only a binary lockfile', async () => {
    await writeFile(join(root, 'bun.lockb'), new Uint8Array([0]))

    const tree = await loadDependencyTree(root)

    expect(tree.coverage.reasons.map((reason) => reason.code)).toEqual(['binary-lockfile'])
  })

  it('prints every installed version with the path each direct dependency brings it in by', async () => {
    await writeFile(join(root, 'bun.lock'), LOCK_TEXT, 'utf8')
    const tree = await loadDependencyTree(root)

    expect(renderDepsWhy('hono', tree, tree.packages.filter((instance) => instance.name === 'hono'))).toBe([
      'hono: 2 installed versions (bun.lock)',
      '',
      'hono@3.12.0 (depth 1; installed in production)',
      '  via old-consumer: old-consumer > hono',
      '',
      'hono@4.13.13 (depth 2; installed in production)',
      '  via @guren/core: @guren/core > @guren/server > hono',
      '  via test-tool: test-tool > @scope/helper > hono',
    ].join('\n'))
  })

  it('exits 0 with the matches as JSON, and 1 for a package the app does not have', async () => {
    await writeFile(join(root, 'bun.lock'), LOCK_TEXT, 'utf8')
    const run = async (...args: string[]) => {
      const proc = Bun.spawn(['bun', CLI_BIN_PATH, 'deps:why', ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { stdout, code }
    }

    const found = await run('test-tool', '--json')
    const missing = await run('left-pad')

    expect(found.code).toBe(0)
    expect(JSON.parse(found.stdout)).toMatchObject({ schemaVersion: 1, lockfile: 'bun.lock', workspace: '', packages: [{ id: 'test-tool@2.1.0' }] })
    expect(missing.code).toBe(1)
    expect(missing.stdout).toContain('left-pad is not installed in this app (bun.lock).')

    await writeFile(join(root, 'bun.lock'), LOCK_TEXT.replace(/^\s+"@scope\/helper": .*\n/mu, ''), 'utf8')
    const partial = await run('test-tool')

    expect(partial.code).toBe(1)
    expect(partial.stdout).toContain('The tree is incomplete, so a path may be missing:')
  })
})
