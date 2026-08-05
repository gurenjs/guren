import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateChannelTypes } from '../src/channel-types'
import { generateDataTypes } from '../src/data-types'
import { generatePageTypes } from '../src/pages-types'
import { generateRouteTypes } from '../src/routes-types'
import { makeController } from '../src/make-controller'
import { makeModel } from '../src/make-model'
import { makeRoute } from '../src/make-route'
import { makeTest } from '../src/make-test'
import { makeView } from '../src/make-view'
import { writeWorkspaceFiles } from './helpers'

/**
 * The codegen generators have to honour `appRoot` on its own — without the
 * caller also steering `process.cwd()` into the project.
 *
 * `guren mcp` is the caller that needs it: it serves a workspace from a
 * long-lived server, so it cannot chdir per request. Every other generator
 * test uses `createTempWorkspace`, which chdir()s — there `appRoot` and
 * `process.cwd()` are the same directory, so a generator that ignored
 * `appRoot` would still pass. These deliberately do not chdir.
 */
describe('codegen resolves against appRoot rather than process.cwd()', () => {
  let appRoot: string
  let cwdBefore: string

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'guren-cli-codegen-approot-'))
    cwdBefore = process.cwd()
  })

  afterEach(async () => {
    expect(process.cwd()).toBe(cwdBefore)
    await rm(appRoot, { recursive: true, force: true })
  })

  it('writes page types under appRoot', async () => {
    await writeWorkspaceFiles(appRoot, {
      'resources/js/pages/posts/Index.tsx': 'export default function Index() { return null }\n',
    })

    const { outputPath } = await generatePageTypes({ appRoot, force: true, extractProps: false })

    expect(outputPath).toBe(join(appRoot, '.guren/pages.gen.ts'))
    expect(existsSync(join(appRoot, '.guren/pages.gen.ts'))).toBe(true)
  })

  it('writes data types under appRoot', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Http/Resources/PostResource.ts':
        "import { JsonResource } from '@guren/core'\n\n"
        + 'export class PostResource extends JsonResource {\n'
        + '  toArray(): { id: number } {\n'
        + '    return { id: 1 }\n'
        + '  }\n'
        + '}\n',
    })

    const { outputPath } = await generateDataTypes({ appRoot, force: true })

    expect(outputPath).toBe(join(appRoot, '.guren/data.gen.ts'))
  })

  it('writes channel types under appRoot', async () => {
    await writeWorkspaceFiles(appRoot, {
      'app/Broadcasting/OrderChannel.ts':
        "import { Channel } from '@guren/core'\n\nexport class OrderChannel extends Channel {}\n",
    })

    const { outputPath } = await generateChannelTypes({ appRoot, force: true })

    expect(outputPath).toBe(join(appRoot, '.guren/channels.gen.ts'))
  })

  it('writes route types under appRoot', async () => {
    await writeWorkspaceFiles(appRoot, {
      'routes/web.ts':
        "import type { Router } from '@guren/core'\n\n"
        + 'export function registerWebRoutes(router: Router): void {\n'
        + "  router.get('/posts', [Object as never, 'index']).name('posts.index')\n"
        + '}\n',
    })

    // Route generation emits two artifacts; `outputPath` names the declaration
    // file, and the runtime manifest lands beside it under `.guren/`.
    const { outputPath } = await generateRouteTypes({ appRoot, force: true })

    expect(outputPath).toBe(join(appRoot, 'types/generated/routes.d.ts'))
    expect(existsSync(join(appRoot, '.guren/routes.gen.ts'))).toBe(true)
  })

  it('leaves no generated output in the directory the process is actually in', async () => {
    await writeWorkspaceFiles(appRoot, {
      'resources/js/pages/posts/Index.tsx': 'export default function Index() { return null }\n',
    })

    await generatePageTypes({ appRoot, force: true, extractProps: false })

    expect(existsSync(join(process.cwd(), '.guren/pages.gen.ts'))).toBe(false)
  })
})

/**
 * The five scaffolders `guren mcp`'s `guren_make_component` dispatches to.
 * Their own test files chdir(), so nothing else covers them being handed an
 * explicit `cwd` — the contract the MCP handler relies on.
 */
describe('single-component scaffolders honour an explicit cwd', () => {
  let root: string
  let cwdBefore: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'guren-cli-scaffold-cwd-'))
    cwdBefore = process.cwd()
  })

  afterEach(async () => {
    expect(process.cwd()).toBe(cwdBefore)
    await rm(root, { recursive: true, force: true })
  })

  const cases: Array<[string, (name: string, opts: { cwd: string }) => Promise<string>, string]> = [
    ['makeController', makeController, 'app/Http/Controllers/ProbeController.ts'],
    ['makeModel', makeModel, 'app/Models/Probe.ts'],
    ['makeView', makeView, 'resources/js/pages/Probe.tsx'],
    ['makeRoute', makeRoute, 'routes/probe.ts'],
  ]

  for (const [label, scaffold, expected] of cases) {
    it(`${label} writes under the given cwd`, async () => {
      const written = await scaffold('Probe', { cwd: root })

      expect(written).toBe(join(root, expected))
      expect(existsSync(join(process.cwd(), expected))).toBe(false)
    })
  }

  it('makeTest detects the runner in the target project, not the process cwd', async () => {
    // The fixture has to disagree with the directory the process is in, or the
    // assertion proves nothing. This monorepo's own package.json lists vitest,
    // so `detectRunner()` reading process.cwd() answers "vitest"; a project
    // with neither a vitest config nor the dependency must get bun:test.
    await writeWorkspaceFiles(root, { 'package.json': '{ "name": "probe-app" }\n' })

    const written = await makeTest('Probe', { cwd: root })

    expect(written).toBe(join(root, 'tests/Probe.test.ts'))
    const contents = await readFile(written, 'utf8')
    expect(contents).toContain("from 'bun:test'")
    expect(contents).not.toContain("from 'vitest'")
  })
})
