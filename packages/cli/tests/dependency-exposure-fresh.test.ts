import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { freshDependencyExposure } from '../src/dependency-exposure-fresh'

// Spawns the real CLI, whose runtime check asks api.github.com. Each fixture's
// bunfig preloads a `fetch` that records the URL and rejects, so no request leaves
// the machine; the recorded URLs show the preload ran in the child. Introspection
// imports the `@guren/core` the entry resolves before the entry itself, which is
// where the marker is written.

function offlineFixture(requests: string): Record<string, string> {
  return {
    'bunfig.toml': 'preload = ["./no-network.ts"]\n\n[install]\nauto = "disable"\n',
    'no-network.ts': `import { appendFileSync } from 'node:fs'
globalThis.fetch = (async (input: string | URL | Request) => {
  appendFileSync(${JSON.stringify(requests)}, \`\${input instanceof Request ? input.url : String(input)}\\n\`)
  throw new TypeError('the test fixture refuses network requests')
}) as typeof fetch
`,
  }
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true })
    await writeFile(join(dir, path), contents)
  }
}

describe('freshDependencyExposure', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-cli-exposure-fresh-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reads a package value starting with `-` as the filter, never as a flag moving the app root', async () => {
    const project = join(root, 'project')
    const foreign = join(root, 'foreign')
    const marker = join(root, 'foreign-code-ran')
    const requests = join(root, 'requests')
    const takeRequestHosts = (): string[] => {
      const hosts = existsSync(requests) ? readFileSync(requests, 'utf8').trim().split('\n').map((url) => new URL(url).host) : []
      rmSync(requests, { force: true })
      return [...new Set(hosts)]
    }
    await writeFiles(project, {
      ...offlineFixture(requests),
      'package.json': JSON.stringify({ name: 'project-app' }),
      'bun.lock': JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'project-app' } }, packages: {} }),
    })
    await writeFiles(foreign, {
      ...offlineFixture(requests),
      'package.json': JSON.stringify({ name: 'foreign-app' }),
      'src/main.ts': 'export default {}\n',
      'node_modules/@guren/core/package.json': JSON.stringify({ name: '@guren/core', type: 'module', main: 'index.js' }),
      'node_modules/@guren/core/index.js': `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'ran')\n`,
    })

    // The fixture runs its code once the CLI is pointed at it, so the absence below can fail.
    await freshDependencyExposure(foreign)
    expect(existsSync(marker)).toBe(true)
    expect(takeRequestHosts()).toEqual(['api.github.com'])
    await rm(marker)

    const injected = await freshDependencyExposure(project, `--app=${foreign}`)

    expect(takeRequestHosts()).toEqual(['api.github.com'])
    expect(existsSync(marker)).toBe(false)
    expect(injected).toMatchObject({ schemaVersion: 1, lockfile: 'bun.lock', packages: [] })
  }, 30_000)
})
