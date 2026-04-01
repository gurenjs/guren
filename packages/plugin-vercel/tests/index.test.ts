import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'bun:test'
import { buildVercelOutput, createVercelHandler, GurenPluginVercelProvider } from '../src/index'

const tempDirs: string[] = []

describe('@guren/plugin-vercel', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('creates a Vercel fetch handler from a bootable app', async () => {
    let booted = false
    const app = {
      async boot() {
        booted = true
      },
      async fetch(request: Request) {
        return new Response(`ok:${new URL(request.url).pathname}`)
      },
    }

    const handler = await createVercelHandler(app)
    const response = await handler.fetch(new Request('http://example.com/hello'))

    expect(booted).toBe(true)
    expect(await response.text()).toBe('ok:/hello')
  })

  it('exports the official provider class', () => {
    expect(typeof GurenPluginVercelProvider).toBe('function')
  })

  it('matches the configured handler filename to the bundled entrypoint', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'guren-plugin-vercel-'))
    tempDirs.push(rootDir)

    const entrypoint = join(rootDir, 'src/vercel.ts')
    mkdirSync(join(rootDir, 'src'), { recursive: true })
    writeFileSync(entrypoint, "export default { fetch() { return new Response('ok') } }\n", 'utf8')

    buildVercelOutput({
      rootDir,
      entrypoint,
      outputDir: join(rootDir, '.vercel/output'),
    })

    const config = JSON.parse(
      readFileSync(join(rootDir, '.vercel/output/functions/index.func/.vc-config.json'), 'utf8'),
    ) as { handler: string }

    expect(config.handler).toBe('vercel.js')
  })
})
