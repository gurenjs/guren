import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { run } from './sync-import-floors'

/**
 * Against throwaway repositories, since every verdict is read from the commits
 * that versioned a package. The server fixture mirrors `internal/request`: a
 * star re-export of a module that gains a name one release after the subpath.
 */
describe('sync-import-floors', () => {
  let scratch: string
  let repoCount = 0

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'guren-import-floors-'))
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  // A global hooksPath or gpgsign would reach these repositories, and CI has no identity.
  const HERMETIC = [
    '-c', 'core.hooksPath=',
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=Guren import-floors test',
    '-c', 'user.email=import-floors-test@guren.dev',
  ]

  function git(repo: string, ...args: string[]): void {
    const proc = Bun.spawnSync(['git', ...HERMETIC, ...args], { cwd: repo })
    if (!proc.success) throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString().trim()}`)
  }

  async function put(repo: string, files: Record<string, string | object>): Promise<void> {
    for (const [path, content] of Object.entries(files)) {
      const full = join(repo, path)
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`, 'utf8')
    }
  }

  function commit(repo: string, message: string): void {
    git(repo, 'add', '-A')
    git(repo, 'commit', '--quiet', '-m', message)
  }

  const SERVER_EXPORTS = {
    '.': './dist/index.js',
    './internal/request': { types: './dist/internal/request.d.ts', default: './dist/internal/request.js' },
  }

  const server = (version: string, exports: object = SERVER_EXPORTS) => ({ name: '@guren/server', version, exports })

  const testing = (peer: string, extra: object = {}) => ({
    name: '@guren/testing',
    version: '1.0.0',
    peerDependencies: { '@guren/server': peer },
    ...extra,
  })

  /** server 1.0.0 exports `parseRequestBody`; 1.1.0 adds `flattenRequestQueries`. */
  async function repository(): Promise<string> {
    const repo = join(scratch, `repo-${++repoCount}`)
    await mkdir(repo, { recursive: true })
    git(repo, 'init', '--quiet', '--initial-branch=main')
    await put(repo, {
      '.changeset/README.md': '# Changesets\n',
      'packages/server/package.json': server('1.0.0'),
      'packages/server/src/index.ts': 'export const root = 1\n',
      'packages/server/src/internal/request.ts': "export * from '../http/request'\nexport type { Context } from '../http/request'\n",
      'packages/server/src/http/request.ts': 'export type Context = object\nexport function parseRequestBody() {}\n',
      'packages/testing/package.json': testing('>=1.0.0'),
      'packages/testing/src/controller.ts': "import { parseRequestBody } from '@guren/server/internal/request'\nparseRequestBody()\n",
    })
    commit(repo, 'server 1.0.0')

    await put(repo, {
      'packages/server/src/http/request.ts':
        'export type Context = object\nexport function parseRequestBody() {}\nexport const flattenRequestQueries = () => {}\n',
    })
    commit(repo, 'feat: flattenRequestQueries')
    await put(repo, { 'packages/server/package.json': server('1.1.0') })
    commit(repo, 'chore: version packages to 1.1.0')
    return repo
  }

  const importBoth = "import { parseRequestBody, flattenRequestQueries } from '@guren/server/internal/request'\n"

  const text = (result: { messages: string[] }) => result.messages.join('\n')

  it('fails a floor admitting a release whose subpath lacks an imported name', async () => {
    const repo = await repository()
    await put(repo, { 'packages/testing/src/controller.ts': importBoth })

    const result = await run({ root: repo, check: true })

    expect(result.code).toBe(1)
    expect(text(result)).toContain('admits @guren/server 1.0.0: ./internal/request without flattenRequestQueries')
    expect(text(result)).toContain('Raise it to ">=1.1.0"')
  })

  it('raises the floor in write mode, after which the check holds', async () => {
    const repo = await repository()
    await put(repo, { 'packages/testing/src/controller.ts': importBoth })

    expect((await run({ root: repo, check: false })).code).toBe(0)

    const manifest = JSON.parse(await readFile(join(repo, 'packages/testing/package.json'), 'utf8'))
    expect(manifest.peerDependencies['@guren/server']).toBe('>=1.1.0')
    expect((await run({ root: repo, check: true })).code).toBe(0)
  })

  it('ignores type-only imports and root entries, and asks only that a dynamic import resolve', async () => {
    const repo = await repository()
    await put(repo, {
      'packages/testing/src/controller.ts':
        "import { parseRequestBody, type Missing } from '@guren/server/internal/request'\n" +
        "import type { AlsoMissing } from '@guren/server/internal/request'\n" +
        "export type { Gone } from '@guren/server/internal/request'\n" +
        "import { notInAnyRelease } from '@guren/server'\n" +
        "const template = `import { flattenRequestQueries } from '@guren/server/internal/request'`\n" +
        "export const lazy = () => import('@guren/server/internal/request')\n",
    })

    const result = await run({ root: repo, check: true })

    expect(text(result)).toBe('Import floors hold across 1 dependency range(s).')
    expect(result.code).toBe(0)
  })

  describe('a subpath no release carries yet', () => {
    async function repositoryWithUnreleasedSubpath(): Promise<string> {
      const repo = await repository()
      await put(repo, {
        'packages/server/package.json': server('1.1.0', {
          ...SERVER_EXPORTS,
          './internal/testing': './dist/internal/testing.js',
        }),
        'packages/server/src/internal/testing.ts': 'export class ServiceProvider {}\n',
        'packages/testing/src/controller.ts': "import { ServiceProvider } from '@guren/server/internal/testing'\n",
      })
      return repo
    }

    it('passes with a note while a pending changeset releases the dependency', async () => {
      const repo = await repositoryWithUnreleasedSubpath()
      await put(repo, { '.changeset/add-testing-subpath.md': "---\n'@guren/server': minor\n---\n\nAdd it.\n" })

      const result = await run({ root: repo, check: true })

      expect(result.code).toBe(0)
      expect(text(result)).toContain('no ./internal/testing subpath')
      expect(text(result)).toContain('release @guren/server as 1.2.0')
    })

    it('fails when no pending changeset releases the dependency', async () => {
      const result = await run({ root: await repositoryWithUnreleasedSubpath(), check: true })

      expect(result.code).toBe(1)
      expect(text(result)).toContain('no pending changeset releases @guren/server')
    })

    it('writes the version `changeset version` just gave the dependency', async () => {
      const repo = await repositoryWithUnreleasedSubpath()
      const manifest = JSON.parse(await readFile(join(repo, 'packages/server/package.json'), 'utf8'))
      await put(repo, { 'packages/server/package.json': { ...manifest, version: '1.2.0' } })

      expect((await run({ root: repo, check: false })).code).toBe(0)

      const written = JSON.parse(await readFile(join(repo, 'packages/testing/package.json'), 'utf8'))
      expect(written.peerDependencies['@guren/server']).toBe('>=1.2.0')
    })
  })

  it('follows a star re-export into another package at the lowest release its range admits', async () => {
    const repo = await repository()
    await put(repo, {
      'packages/core/package.json': {
        name: '@guren/core',
        version: '1.0.0',
        exports: { './internal/request': './dist/internal/request.js' },
        dependencies: { '@guren/server': '^1.0.0' },
      },
      'packages/core/src/internal/request.ts': "export * from '@guren/server/internal/request'\n",
      'packages/openapi/package.json': { name: '@guren/openapi', version: '1.0.0', dependencies: { '@guren/core': '^1.0.0' } },
      'packages/openapi/src/index.ts': "import { flattenRequestQueries } from '@guren/core/internal/request'\n",
    })
    commit(repo, 'core 1.0.0')

    const result = await run({ root: repo, check: true })

    expect(result.code).toBe(1)
    expect(text(result)).toContain('admits @guren/core 1.0.0: ./internal/request without flattenRequestQueries')
  })

  it('fails a subpath import of a package the dependent does not declare', async () => {
    const repo = await repository()
    await put(repo, { 'packages/testing/package.json': testing('>=1.0.0', { peerDependencies: {} }) })

    const result = await run({ root: repo, check: true })

    expect(result.code).toBe(1)
    expect(text(result)).toContain('declares no @guren/server in dependencies or peerDependencies')
  })

  it('cannot run on a range shape it takes no floor from', async () => {
    const repo = await repository()
    await put(repo, { 'packages/testing/package.json': testing('workspace:*') })

    const result = await run({ root: repo, check: true })

    expect(result.code).toBe(2)
    expect(text(result)).toContain('a range shape this script cannot take a floor from')
  })

  it('cannot run on a shallow clone', async () => {
    const source = await repository()
    const clone = join(scratch, `clone-${++repoCount}`)
    git(scratch, 'clone', '--quiet', '--depth', '1', `file://${source}`, clone)

    const result = await run({ root: clone, check: true })

    expect(result.code).toBe(2)
    expect(text(result)).toContain('fetch-depth: 0')
  })
})
