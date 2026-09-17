import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CannotJudge, type Surface } from '../sync-import-floors'
import {
  judgePublishedImports,
  readTarball,
  releaseLineHeads,
  run,
  type PublishedRelease,
} from './published-imports-audit'

const DEPLOY_BUILD = `import { appUsesMcpPlugin, resetOutputDir } from "@guren/core/internal/deploy-build";
import { definePlugin } from "@guren/core";
import { handler } from "@guren/plugin-lambda/cdk";
export const build = () => [appUsesMcpPlugin, resetOutputDir, definePlugin, handler];
`

function surfaces(entries: Record<string, Partial<Surface> & { names?: string[] }>) {
  return (pkg: string, subpath: string): Surface => {
    const entry = entries[`${pkg}#${subpath}`]
    if (!entry) return { exists: false, names: new Set(), open: false }
    return { exists: true, open: entry.open ?? false, names: new Set(entry.names ?? []) }
  }
}

const lambda = (range: string, source = DEPLOY_BUILD): PublishedRelease => ({
  name: '@guren/plugin-lambda',
  version: '0.6.1',
  ranges: { dependencies: { '@guren/core': range } },
  files: [{ path: 'package/dist/build-CDHl9ytl.js', source }],
})

const CORE_WITHOUT_MCP = surfaces({
  '@guren/core#./internal/deploy-build': { names: ['resetOutputDir'] },
  '@guren/core#.': { names: ['definePlugin'] },
})

describe('judgePublishedImports', () => {
  it('names the published release, the specifier, the missing name and the admitting range', () => {
    const result = judgePublishedImports([lambda('^1.19.0')], [{ name: '@guren/core', version: '1.20.0' }], CORE_WITHOUT_MCP)

    expect(result.pairsChecked).toBe(1)
    expect(result.failures).toHaveLength(1)
    const [failure] = result.failures
    expect(failure).toContain('@guren/plugin-lambda@0.6.1')
    expect(failure).toContain('@guren/core/internal/deploy-build without appUsesMcpPlugin')
    expect(failure).toContain('package/dist/build-CDHl9ytl.js')
    expect(failure).toContain('dependencies["@guren/core"] is "^1.19.0"')
    expect(failure).not.toContain('resetOutputDir')
  })

  it('passes when the release still exports every imported name', () => {
    const core = surfaces({
      '@guren/core#./internal/deploy-build': { names: ['resetOutputDir', 'appUsesMcpPlugin'] },
      '@guren/core#.': { names: ['definePlugin'] },
    })
    const result = judgePublishedImports([lambda('^1.19.0')], [{ name: '@guren/core', version: '1.20.0' }], core)
    expect(result).toEqual({ failures: [], pairsChecked: 1 })
  })

  it.each([
    ['a caret on an older major', '^0.5.0'],
    ['an exact pin on the published version', '1.19.0'],
    ['a tilde that stops before the release', '~1.19.0'],
  ])('ignores %s, which never installs beside the release', (_label, range) => {
    const result = judgePublishedImports([lambda(range)], [{ name: '@guren/core', version: '1.20.0' }], CORE_WITHOUT_MCP)
    expect(result).toEqual({ failures: [], pairsChecked: 0 })
  })

  it('reads peerDependencies when dependencies do not name the release', () => {
    const published = { ...lambda('^1.19.0'), ranges: { peerDependencies: { '@guren/core': '>=1.0.0' } } }
    const result = judgePublishedImports([published], [{ name: '@guren/core', version: '1.20.0' }], CORE_WITHOUT_MCP)
    expect(result.failures[0]).toContain('peerDependencies["@guren/core"] is ">=1.0.0"')
  })

  it('reports a subpath the release no longer ships, even when only a dynamic import reaches it', () => {
    const source = 'export const load = () => import("@guren/core/internal/deploy-check");\n'
    const result = judgePublishedImports([lambda('^1.19.0', source)], [{ name: '@guren/core', version: '1.20.0' }], CORE_WITHOUT_MCP)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]).toContain('ships no @guren/core/internal/deploy-check subpath')
  })

  it('ignores a package importing its own subpaths and a dependency that is not releasing', () => {
    const result = judgePublishedImports(
      [lambda('^1.19.0')],
      [{ name: '@guren/plugin-lambda', version: '0.7.0' }, { name: '@guren/server', version: '2.25.0' }],
      () => {
        throw new Error('no surface should be read')
      },
    )
    expect(result).toEqual({ failures: [], pairsChecked: 0 })
  })

  it('cannot judge a missing name behind a star re-export from outside the workspace', () => {
    const open = surfaces({
      '@guren/core#./internal/deploy-build': { names: ['resetOutputDir'], open: true },
      '@guren/core#.': { names: ['definePlugin'] },
    })
    expect(() => judgePublishedImports([lambda('^1.19.0')], [{ name: '@guren/core', version: '1.20.0' }], open)).toThrow(
      CannotJudge,
    )
  })
})

describe('releaseLineHeads', () => {
  it('keeps the newest stable version per major, and per minor below 1.0.0', () => {
    expect(releaseLineHeads(['0.6.0', '0.6.1', '0.7.0-next.0', '0.5.0', '1.2.0', '1.10.0', '2.0.0-rc.1'])).toEqual([
      '0.5.0',
      '0.6.1',
      '1.10.0',
    ])
  })
})

describe('readTarball', () => {
  let scratch: string

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'guren-published-imports-'))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  it('reads every regular file, including paths longer than the 100-byte name field', async () => {
    const deep = `package/dist/${'nested-directory/'.repeat(6)}chunk-with-a-long-name.js`
    const files = { 'package/package.json': '{"name":"x"}\n', 'package/dist/index.js': DEPLOY_BUILD, [deep]: 'export {}\n' }
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(scratch, path, '..'), { recursive: true })
      await writeFile(join(scratch, path), content)
    }
    const tgz = join(scratch, 'fixture.tgz')
    const tar = Bun.spawnSync(['tar', '-czf', tgz, 'package'], { cwd: scratch, env: { ...process.env, COPYFILE_DISABLE: '1' } })
    expect(tar.success).toBe(true)

    const entries = readTarball(new Uint8Array(await readFile(tgz)))
    expect(Object.fromEntries(entries.map((entry) => [entry.path, entry.source]))).toEqual(files)
  })
})

describe('run', () => {
  it.each([
    ['a registry error status', async () => new Response('unavailable', { status: 503 })],
    [
      'a network failure',
      async (): Promise<Response> => {
        throw new TypeError('fetch failed')
      },
    ],
  ])('exits 2 on %s rather than passing', async (_label, fetch) => {
    const result = await run({ fetch })
    expect(result.code).toBe(2)
    expect(result.messages.join('\n')).toContain('could not be read from the registry')
  })

  it('treats a package the registry has never heard of as nothing to break', async () => {
    const result = await run({ fetch: async () => new Response('{}', { status: 404 }) })
    expect(result.code).toBe(0)
  })
})
