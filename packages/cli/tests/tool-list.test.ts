import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createTempWorkspace, linkWorkspaceCore, type TempWorkspace } from './helpers'
import { listTools, displayTools, displayToolInspection } from '../src/tool-list'

const repoRoot = resolve(import.meta.dir, '../../..')

/**
 * `createTempWorkspace` disables Bun's auto-install, so a fixture importing
 * `@guren/core` or `zod` must be linked to this checkout — otherwise it binds
 * whatever the machine has installed and calls that a test of this workspace.
 */
async function linkFixtureDependencies(dir: string): Promise<void> {
  await linkWorkspaceCore(dir)
  const zodLink = join(dir, 'node_modules', 'zod')
  await mkdir(dirname(zodLink), { recursive: true })
  await symlink(join(repoRoot, 'node_modules', 'zod'), zodLink, 'dir')
}

/**
 * The manifest is deliberately never written here: deriving live without one is
 * the property these commands exist for.
 */
const ROUTES = `import { Router, authorizeMiddleware } from '@guren/core'
import { z } from 'zod'

export function registerWebRoutes(router: Router): void {
  router
    .get('/posts', { name: 'posts.index', query: z.object({ page: z.coerce.number().optional() }) }, () => 'posts')
    .agent({ description: 'List published posts.' })
  router
    .post('/posts/:id/publish', { name: 'posts.publish', body: z.object({ note: z.string() }) }, () => 'ok')
    .middleware(authorizeMiddleware('publish-post'))
    .agent({ description: 'Publish a post.', approval: 'required', redact: ['note'] })
  router.get('/health', () => 'ok').name('health')
}

export default registerWebRoutes
`

describe('tool-list', () => {
  let workspace: TempWorkspace
  let tempDir: string
  let output: string[]

  beforeEach(async () => {
    workspace = await createTempWorkspace('guren-cli-tool-test-')
    tempDir = workspace.dir
    await linkFixtureDependencies(tempDir)
    await mkdir(join(tempDir, 'routes'), { recursive: true })
    await writeFile(join(tempDir, 'routes/web.ts'), ROUTES)
    output = []
  })

  afterEach(async () => {
    await workspace.cleanup()
  })

  function captureStdout() {
    return spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(' '))
    })
  }

  describe('listTools', () => {
    it('derives only the routes that declare agent metadata', async () => {
      const { tools, warnings } = await listTools({ appRoot: tempDir })

      expect(tools.map((tool) => tool.toolName).sort()).toEqual(['posts.index', 'posts.publish'])
      expect(warnings).toEqual([])
    })

    it('resolves the ability a route’s middleware chain stamped', async () => {
      const { tools } = await listTools({ appRoot: tempDir })
      const publish = tools.find((tool) => tool.toolName === 'posts.publish')

      expect(publish?.authorization).toEqual({ ability: 'publish-post' })
      expect(publish?.annotations.readOnlyHint).toBe(false)
      expect(publish?.approval).toBe('required')
    })

    it('names the routes file when it cannot be imported', async () => {
      await rm(join(tempDir, 'routes/web.ts'))

      await expect(listTools({ appRoot: tempDir })).rejects.toThrow('Failed to import routes file')
    })
  })

  describe('displayTools', () => {
    it('prints a row per tool with exposure, ability and annotations', async () => {
      const spy = captureStdout()
      try {
        await displayTools({ appRoot: tempDir })
      } finally {
        spy.mockRestore()
      }

      const text = output.join('\n')
      expect(text).toContain('Tool')
      expect(text).toContain('posts.index')
      expect(text).toContain('posts.publish')
      expect(text).toContain('publish-post')
      expect(text).toContain('read-only, idempotent')
      expect(text).not.toContain('health')
      expect(text).toContain('Total: 2 tools')
    })

    it('emits the derived tools and warnings as JSON', async () => {
      const spy = captureStdout()
      try {
        await displayTools({ appRoot: tempDir, json: true })
      } finally {
        spy.mockRestore()
      }

      const payload = JSON.parse(output.join('\n')) as {
        tools: Array<{ toolName: string; expose: { mcp: boolean }; warnings: string[] }>
        warnings: string[]
      }
      expect(payload.tools.map((tool) => tool.toolName).sort()).toEqual(['posts.index', 'posts.publish'])
      expect(payload.tools[0]!.expose.mcp).toBe(true)
      expect(payload.warnings).toEqual([])
    })

    it('says so when an app exposes nothing', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/health', () => 'ok').name('health')
}

export default registerWebRoutes
`,
      )
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      const consola = await import('consola')
      const consolaWarn = spyOn(consola.consola, 'warn').mockImplementation(((message: unknown) => {
        output.push(String(message))
      }) as never)
      try {
        await displayTools({ appRoot: tempDir })
      } finally {
        consolaWarn.mockRestore()
        warn.mockRestore()
      }

      expect(output.join('\n')).toContain('No agent tools found')
    })
  })

  describe('displayToolInspection', () => {
    it('shows one tool’s input, exposure, ability and annotations', async () => {
      const spy = captureStdout()
      try {
        await displayToolInspection('posts.publish', { appRoot: tempDir })
      } finally {
        spy.mockRestore()
      }

      const text = output.join('\n')
      expect(text).toContain('POST /posts/:id/publish')
      expect(text).toContain('Publish a post.')
      expect(text).toContain('publish-post')
      expect(text).toContain('Approval:')
      expect(text).toContain('Redacted:')
      expect(text).toContain('id: string')
      expect(text).toContain('note: string')
      expect(text).toContain('(no output schema)')
    })

    it('aligns every label to the same column', async () => {
      const spy = captureStdout()
      try {
        await displayToolInspection('posts.publish', { appRoot: tempDir })
      } finally {
        spy.mockRestore()
      }

      // `Authorization:` is the longest label (14 characters).
      const labelled = output.filter((line) => /^(Description|Exposure|Annotations|Authorization|Approval|Redacted):/u.test(line))
      expect(labelled.length).toBeGreaterThan(3)
      // The column each value starts in; one distinct value means they line up.
      const valueColumns = new Set(
        labelled.map((line) => line.length - line.replace(/^[A-Za-z]+:\s+/u, '').length),
      )
      expect(labelled.some((line) => line.startsWith('Authorization:'))).toBe(true)
      expect([...valueColumns]).toEqual([15])
    })

    it('emits one tool and only its own warnings as JSON', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `import { Router } from '@guren/core'
import { z } from 'zod'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', { name: 'posts.index', query: z.string(), agent: {} }, () => 'posts')
  router.get('/tags', { name: 'tags.index', query: z.string(), agent: {} }, () => 'tags')
}

export default registerWebRoutes
`,
      )
      const spy = captureStdout()
      try {
        await displayToolInspection('posts.index', { appRoot: tempDir, json: true })
      } finally {
        spy.mockRestore()
      }

      const payload = JSON.parse(output.join('\n')) as {
        tool: { toolName: string; warnings: string[] }
        warnings: string[]
      }
      expect(payload.tool.toolName).toBe('posts.index')
      // Attribution comes off the tool, so the sibling route's identical warning
      // does not leak in.
      expect(payload.warnings).toHaveLength(1)
      expect(payload.warnings).toEqual(payload.tool.warnings)
      expect(payload.warnings[0]).toContain('GET /posts query')
    })

    it('names the Resource class behind a hint rather than a generated file', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `import { Router } from '@guren/core'

class ArticleResource {
  toJSON(): unknown { return {} }
}

export function registerWebRoutes(router: Router): void {
  router.get('/posts', { name: 'posts.index', resource: { data: [ArticleResource] }, agent: {} }, () => 'posts')
}

export default registerWebRoutes
`,
      )
      const spy = captureStdout()
      try {
        await displayToolInspection('posts.index', { appRoot: tempDir })
      } finally {
        spy.mockRestore()
      }

      const text = output.join('\n')
      expect(text).toContain('ArticleResource')
      // The manifest may not exist — this command derives live precisely so it
      // can answer without one.
      expect(text).not.toContain('agents.gen.ts')
    })

    it('lists the available tools when the name is unknown', async () => {
      await expect(displayToolInspection('nope', { appRoot: tempDir })).rejects.toThrow(
        /No agent tool named "nope"\..*posts\.index, posts\.publish/su,
      )
    })

    it('says the app exposes none when there are no tools at all', async () => {
      await writeFile(
        join(tempDir, 'routes/web.ts'),
        `import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/health', () => 'ok').name('health')
}

export default registerWebRoutes
`,
      )

      await expect(displayToolInspection('nope', { appRoot: tempDir })).rejects.toThrow(
        'This app exposes no agent tools',
      )
    })
  })
})
