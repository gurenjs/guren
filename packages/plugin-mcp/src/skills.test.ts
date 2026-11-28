import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import {
  EventServiceProvider,
  MemoryApiTokenStore,
  createApiToken,
  createApp,
  type Application,
  type Router,
} from '@guren/core'
import { z } from 'zod'

import { mcpPlugin, type McpPluginConfig } from './plugin'
import { getSkill, listSkills, loadSkills, readSkillResource, type McpSkillFilesModule } from './skills'

type ProtocolEra = 'modern' | 'legacy'

const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills'
const UI_EXTENSION = 'io.modelcontextprotocol/ui'
const INVALID_PARAMS = -32602
const METHOD_NOT_FOUND = -32601

const REFUNDS = '---\nname: refunds\ndescription: Process a refund per shop policy\n---\n\n# Refunds\n\nSee references/policy.md.\n'
const POLICY = '# Policy\n\n返金は 30 日以内に受け付けます。\n'
const DUNNING = '---\nname: dunning\ndescription: Chase an unpaid invoice\n---\n\nBody.\n'
const LOGO_BYTES = [0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01]

function skillsModule(): McpSkillFilesModule {
  return {
    files: {
      'refunds/SKILL.md': REFUNDS,
      'refunds/references/policy.md': POLICY,
      // A file whose name needs percent-encoding in its URI.
      'refunds/references/返金 規程.md': '# 規程\n',
      // A module's skill: the module name is the organizational prefix.
      'billing/dunning/SKILL.md': DUNNING,
    },
    binary: { 'refunds/assets/logo.png': btoa(String.fromCharCode(...LOGO_BYTES)) },
  }
}

function bulkModule(count: number): McpSkillFilesModule {
  const files: Record<string, string> = {}
  for (let index = 0; index < count; index++) {
    const name = `bulk-${String(index).padStart(3, '0')}`
    files[`${name}/SKILL.md`] = `---\nname: ${name}\ndescription: Bulk skill ${index}\n---\n`
  }
  return { files, binary: {} }
}

/** A result schema for a method the client has no spec schema for. */
const AnyResult = z.looseObject({})

interface Endpoint {
  connect(era: ProtocolEra): Promise<Client>
}

async function bootEndpoint(config: McpPluginConfig, routes?: (router: Router) => void): Promise<Endpoint> {
  const store = new MemoryApiTokenStore()
  const app: Application = createApp({
    routes:
      routes
      ?? ((router) => {
        router.get('/whoami', () => Response.json({ ok: true })).name('whoami.show').agent({ description: 'Echo' })
      }),
    providers: [EventServiceProvider, mcpPlugin(config)],
  })
  app.auth.useTokens(store)
  await app.boot()
  const bearer = (await createApiToken(store, { name: 'reader', userId: 1, abilities: ['tools:*'] })).plainTextToken

  return {
    async connect(era) {
      const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: (input, init) => app.fetch(new Request(input, init)),
        requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      })
      const client = new Client(
        { name: `skills-${era}`, version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
      )
      await client.connect(transport)
      return client
    },
  }
}

describe('loadSkills', () => {
  let warn: Mock<typeof console.warn>

  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  test('should serve nothing when the app configured no skills', async () => {
    expect(await loadSkills(undefined)).toBeUndefined()
  })

  test('should serve nothing, silently, for the empty module codegen keeps after the last skill is removed', async () => {
    expect(await loadSkills({ files: () => ({ files: {}, binary: {} }) })).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })

  test('should fail the boot on a module of another shape', async () => {
    const wrong = { mcpAppPages: {} } as unknown as McpSkillFilesModule

    await expect(loadSkills({ files: () => wrong })).rejects.toThrow('.guren/mcp-skills.gen.ts')
  })

  test('should fail the boot on files held in anything but a plain object', async () => {
    const mapped = { files: new Map([['refunds/SKILL.md', REFUNDS]]), binary: {} } as unknown as McpSkillFilesModule

    await expect(loadSkills({ files: () => mapped })).rejects.toThrow('.guren/mcp-skills.gen.ts')
  })

  test('should name the option when the module cannot be loaded, keeping the cause', async () => {
    const cause = new Error('unavailable')

    const failure = await loadSkills({ files: () => Promise.reject(cause) }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('`skills.files`')
    expect((failure as Error).cause).toBe(cause)
  })

  test('should fail the boot on a path with an empty, "." or ".." segment', async () => {
    for (const path of ['refunds/./notes.md', 'refunds//notes.md', '/refunds/notes.md', 'refunds/../notes.md']) {
      const module: McpSkillFilesModule = { files: { 'refunds/SKILL.md': REFUNDS, [path]: 'x' }, binary: {} }

      await expect(loadSkills({ files: () => module })).rejects.toThrow(`holds the path ${JSON.stringify(path)}`)
    }
  })

  test('should serve the bytes the catalog hashed when the module changes while it loads', async () => {
    const files: Record<string, string> = { 'refunds/SKILL.md': REFUNDS, 'refunds/check.txt': 'before' }

    const pending = loadSkills({ files: () => ({ files, binary: {} }) })
    queueMicrotask(() => {
      files['refunds/check.txt'] = 'changed while the catalog was being built'
    })
    const skills = (await pending)!

    const listed = (getSkill(skills, 'skill://refunds/SKILL.md').skill.resources as Array<{ uri: string; size?: number }>).find(
      (resource) => resource.uri === 'skill://refunds/check.txt',
    )
    const served = readSkillResource('skill://refunds/check.txt', skills) as { text: string }
    expect(files['refunds/check.txt']).not.toBe('before')
    expect(new TextEncoder().encode(served.text)).toHaveLength(listed!.size!)
  })

  test('should fail the boot on a path listed as both text and binary', async () => {
    const module: McpSkillFilesModule = { files: { 'refunds/SKILL.md': REFUNDS }, binary: { 'refunds/SKILL.md': 'AA==' } }

    await expect(loadSkills({ files: () => module })).rejects.toThrow('"refunds/SKILL.md" as both text and binary')
  })

  test('should fail the boot on a binary file that is not base64', async () => {
    const module: McpSkillFilesModule = { files: { 'refunds/SKILL.md': REFUNDS }, binary: { 'refunds/logo.png': '***' } }

    await expect(loadSkills({ files: () => module })).rejects.toThrow('"refunds/logo.png" as binary')
  })

  test('should fail the boot on a skill nested inside another, a module prefix included', async () => {
    const nested: McpSkillFilesModule = { files: { 'refunds/SKILL.md': REFUNDS, 'refunds/extra/SKILL.md': 'x' }, binary: {} }
    const shadowed: McpSkillFilesModule = { files: { 'billing/SKILL.md': REFUNDS, 'billing/dunning/SKILL.md': DUNNING }, binary: {} }

    await expect(loadSkills({ files: () => nested })).rejects.toThrow('"refunds/extra/SKILL.md" sits inside the skill "refunds/SKILL.md"')
    await expect(loadSkills({ files: () => shadowed })).rejects.toThrow('"billing/dunning/SKILL.md" sits inside the skill "billing/SKILL.md"')
  })

  test('should skip a skill the catalog refuses, name its file once, and publish none of its files', async () => {
    const module = skillsModule()
    const files = { ...module.files, 'broken/SKILL.md': 'no frontmatter here\n', 'broken/notes.md': 'notes\n' }

    const skills = await loadSkills({ files: () => ({ files, binary: module.binary }) })

    expect(skills?.entries.map((entry) => entry.uri)).toEqual(['skill://billing/dunning/SKILL.md', 'skill://refunds/SKILL.md'])
    expect(readSkillResource('skill://broken/SKILL.md', skills!)).toBeUndefined()
    expect(readSkillResource('skill://broken/notes.md', skills!)).toBeUndefined()
    const named = warn.mock.calls.filter(([message]) => String(message).includes('broken/SKILL.md'))
    expect(named).toHaveLength(1)
    expect(String(named[0]![0])).toStartWith('[@guren/plugin-mcp]')
  })

  test('should publish every file of a skill, text as text and anything else as a base64 blob', async () => {
    const skills = (await loadSkills({ files: () => skillsModule() }))!

    expect(readSkillResource('skill://refunds/references/policy.md', skills)).toEqual({
      uri: 'skill://refunds/references/policy.md',
      mimeType: 'text/markdown',
      text: POLICY,
    })
    expect(readSkillResource('skill://refunds/assets/logo.png', skills)).toEqual({
      uri: 'skill://refunds/assets/logo.png',
      mimeType: 'image/png',
      blob: btoa(String.fromCharCode(...LOGO_BYTES)),
    })
    expect(readSkillResource('skill://refunds/nope.md', skills)).toBeUndefined()
    expect(readSkillResource('not a uri', skills)).toBeUndefined()
  })

  test('should decide text or blob by the bytes, and the type by the decoded file name', async () => {
    const module: McpSkillFilesModule = {
      // The extension holds U+212A, which lowercases to "k" and is percent-encoded in the URI.
      files: { 'refunds/SKILL.md': REFUNDS, 'refunds/readme.marKdown': '# k\n' },
      binary: {
        'refunds/hi.txt': 'aGk=',
        'refunds/bom.txt': btoa(String.fromCharCode(0xef, 0xbb, 0xbf, 0x68, 0x69)),
        // Unpadded in the module, canonical base64 on the wire.
        'refunds/raw.bin': '//4',
      },
    }

    const skills = (await loadSkills({ files: () => module }))!

    expect(readSkillResource('skill://refunds/readme.mar%E2%84%AAdown', skills)).toMatchObject({ mimeType: 'text/markdown' })
    expect(readSkillResource('skill://refunds/hi.txt', skills)).toEqual({ uri: 'skill://refunds/hi.txt', mimeType: 'text/plain', text: 'hi' })
    expect(readSkillResource('skill://refunds/bom.txt', skills)).toMatchObject({ text: '﻿hi' })
    expect(readSkillResource('skill://refunds/raw.bin', skills)).toEqual({
      uri: 'skill://refunds/raw.bin',
      mimeType: 'application/octet-stream',
      blob: '//4=',
    })
  })
})

describe('listSkills', () => {
  test('should page at 100 in URI order and end without a cursor', async () => {
    const skills = (await loadSkills({ files: () => bulkModule(150) }))!

    const first = listSkills(skills, undefined)
    const second = listSkills(skills, first.nextCursor)

    expect(first.skills).toHaveLength(100)
    expect(first.skills[0]!.uri).toBe('skill://bulk-000/SKILL.md')
    expect(second.skills).toHaveLength(50)
    expect(second.skills[0]!.uri).toBe('skill://bulk-100/SKILL.md')
    expect(second.nextCursor).toBeUndefined()
  })

  test('should carry the fixed cache fields on every result', async () => {
    const skills = (await loadSkills({ files: () => skillsModule() }))!

    expect(listSkills(skills, undefined)).toMatchObject({ ttlMs: 0, cacheScope: 'private' })
    expect(getSkill(skills, 'skill://refunds/SKILL.md')).toMatchObject({ ttlMs: 0, cacheScope: 'private' })
  })

  test('should refuse a cursor that is not base64, lacks the prefix, or is not UTF-8', async () => {
    const skills = (await loadSkills({ files: () => skillsModule() }))!

    expect(() => listSkills(skills, 'garbage!')).toThrow('Invalid cursor')
    expect(() => listSkills(skills, btoa('before:skill://refunds/SKILL.md'))).toThrow('Invalid cursor')
    // "after:" followed by the byte FF.
    expect(() => listSkills(skills, 'YWZ0ZXI6_w')).toThrow('Invalid cursor')
  })
})

/**
 * The Skills extension on the App MCP endpoint (RFC 0042 §1), end to end
 * through the SDK's own host-side client, which checks every file it reads
 * against the size and digest of the entry that listed it.
 */
describe('mcpPlugin skills (RFC 0042)', () => {
  let endpoint: Endpoint

  beforeAll(async () => {
    endpoint = await bootEndpoint({ rateLimit: false, skills: { files: () => skillsModule() } })
  })

  describe('on a 2026-07-28 client', () => {
    test('should declare the extension beside resources, without directoryRead', async () => {
      const client = await endpoint.connect('modern')
      const capabilities = client.getServerCapabilities()

      expect(capabilities?.resources).toBeDefined()
      expect(capabilities?.extensions?.[SKILLS_EXTENSION]).toEqual({})
      expect(new SkillsClient(client).supported).toBe(true)
      expect(new SkillsClient(client).directoryRead).toBe(false)

      await client.close()
    })

    test('should list every skill with its whole manifest and the fixed cache fields', async () => {
      const client = await endpoint.connect('modern')

      const listing = await new SkillsClient(client).list()

      expect(listing.invalid).toEqual([])
      expect(listing).toMatchObject({ ttlMs: 0, cacheScope: 'private' })
      expect(listing.skills.map((skill) => skill.uri)).toEqual(['skill://billing/dunning/SKILL.md', 'skill://refunds/SKILL.md'])
      const refunds = listing.skills[1]!
      expect(refunds.frontmatter).toEqual({ name: 'refunds', description: 'Process a refund per shop policy' })
      expect((refunds.resources as Array<{ uri: string }>).map((resource) => resource.uri).sort()).toEqual([
        'skill://refunds/SKILL.md',
        'skill://refunds/assets/logo.png',
        'skill://refunds/references/%E8%BF%94%E9%87%91%20%E8%A6%8F%E7%A8%8B.md',
        'skill://refunds/references/policy.md',
      ])

      await client.close()
    })

    test('should serve bytes that match the digest of the entry that listed them', async () => {
      const client = await endpoint.connect('modern')
      const skills = new SkillsClient(client)
      const { skill } = await skills.get('skill://refunds/SKILL.md')

      const manifest = await skills.read(skill)
      const policy = await skills.read(skill, 'references/policy.md')
      const encoded = await skills.read(skill, 'references/返金 規程.md')
      const logo = await skills.read(skill, 'assets/logo.png')

      expect(manifest).toMatchObject({ verified: true, mimeType: 'text/markdown', text: REFUNDS })
      expect(policy).toMatchObject({ verified: true, text: POLICY })
      expect(encoded).toMatchObject({ verified: true, text: '# 規程\n' })
      expect(logo).toMatchObject({ verified: true, mimeType: 'image/png' })
      expect([...logo.bytes]).toEqual(LOGO_BYTES)

      await client.close()
    })

    test('should answer invalid params for a URI that names no skill', async () => {
      const client = await endpoint.connect('modern')
      const skills = new SkillsClient(client)

      await expect(skills.get('skill://nope/SKILL.md')).rejects.toMatchObject({ code: INVALID_PARAMS })
      // A supporting file is no skill, however real it is.
      await expect(skills.get('skill://refunds/references/policy.md')).rejects.toMatchObject({ code: INVALID_PARAMS })

      await client.close()
    })

    // The SDK stamps these on a 2026-07-28 result; this pins what reaches the client.
    test('should mark a file read as private and not to be kept', async () => {
      const client = await endpoint.connect('modern')

      const result = await client.readResource({ uri: 'skill://refunds/references/policy.md' })

      expect(result).toMatchObject({ ttlMs: 0, cacheScope: 'private' })

      await client.close()
    })

    test('should refuse malformed params and a cursor it did not issue', async () => {
      const client = await endpoint.connect('modern')

      await expect(client.request({ method: 'skills/get', params: {} }, AnyResult)).rejects.toMatchObject({
        code: INVALID_PARAMS,
      })
      await expect(
        client.request({ method: 'skills/list', params: { cursor: 'garbage!' } }, AnyResult),
      ).rejects.toMatchObject({ code: INVALID_PARAMS })

      await client.close()
    })
  })

  describe('on a 2025-era client', () => {
    test('should declare no extension and answer neither skills method', async () => {
      const client = await endpoint.connect('legacy')

      expect(client.getServerCapabilities()?.extensions?.[SKILLS_EXTENSION]).toBeUndefined()
      expect(new SkillsClient(client).supported).toBe(false)
      await expect(client.request({ method: 'skills/list', params: {} }, AnyResult)).rejects.toMatchObject({
        code: METHOD_NOT_FOUND,
      })
      await expect(
        client.request({ method: 'skills/get', params: { uri: 'skill://refunds/SKILL.md' } }, AnyResult),
      ).rejects.toMatchObject({ code: METHOD_NOT_FOUND })

      await client.close()
    })
  })

  for (const era of ['modern', 'legacy'] as const) {
    describe(`as plain resources on a ${era} client`, () => {
      test('should list each SKILL.md and no supporting file', async () => {
        const client = await endpoint.connect(era)

        const { resources } = await client.listResources()

        expect(resources).toEqual([
          {
            uri: 'skill://billing/dunning/SKILL.md',
            name: 'dunning',
            description: 'Chase an unpaid invoice',
            mimeType: 'text/markdown',
          },
          {
            uri: 'skill://refunds/SKILL.md',
            name: 'refunds',
            description: 'Process a refund per shop policy',
            mimeType: 'text/markdown',
          },
        ])

        await client.close()
      })

      test('should read a supporting file and refuse one the catalog does not publish', async () => {
        const client = await endpoint.connect(era)

        const { contents } = await client.readResource({ uri: 'skill://refunds/references/policy.md' })

        expect(contents).toEqual([{ uri: 'skill://refunds/references/policy.md', mimeType: 'text/markdown', text: POLICY }])
        await expect(client.readResource({ uri: 'skill://refunds/nope.md' })).rejects.toMatchObject({
          code: INVALID_PARAMS,
        })

        await client.close()
      })
    })
  }
})

describe('mcpPlugin skills beside the rest of the endpoint', () => {
  test('should advertise nothing new for an app that configured no skills', async () => {
    const endpoint = await bootEndpoint({ rateLimit: false })
    const client = await endpoint.connect('modern')

    expect(client.getServerCapabilities()).toEqual({ tools: {} })

    await client.close()
  })

  test('should serve skills and MCP Apps from one resource list', async () => {
    const endpoint = await bootEndpoint(
      {
        rateLimit: false,
        skills: { files: () => skillsModule() },
        ui: { pages: () => ({ mcpAppPages: { 'drafts/Show': { html: '<!DOCTYPE html><html></html>', hash: 'h1' } } }) },
      },
      (router) => {
        router.get('/drafts/:id', () => Response.json({})).name('drafts.show').agent({ ui: 'drafts/Show' })
      },
    )
    const client = await endpoint.connect('modern')

    const { resources } = await client.listResources()
    const bridge = await client.readResource({ uri: 'ui://guren-app/bridge' })

    expect(Object.keys(client.getServerCapabilities()?.extensions ?? {}).sort()).toEqual([SKILLS_EXTENSION, UI_EXTENSION])
    expect(resources.map((resource) => resource.uri)).toEqual([
      'ui://guren-app/pages/drafts/Show?v=h1',
      'ui://guren-app/bridge',
      'skill://billing/dunning/SKILL.md',
      'skill://refunds/SKILL.md',
    ])
    expect(bridge.contents[0]).toMatchObject({ uri: 'ui://guren-app/bridge', mimeType: 'application/json' })

    await client.close()
  })

  test('should serve the second page of a catalog past 100 skills', async () => {
    const endpoint = await bootEndpoint({ rateLimit: false, skills: { files: () => bulkModule(150) } })
    const client = await endpoint.connect('modern')

    const first = await client.request({ method: 'skills/list', params: {} }, AnyResult)
    const second = await client.request({ method: 'skills/list', params: { cursor: first.nextCursor } }, AnyResult)

    expect(first.skills).toHaveLength(100)
    expect(second.skills).toHaveLength(50)
    expect((second.skills as Array<{ uri: string }>)[0]!.uri).toBe('skill://bulk-100/SKILL.md')
    expect(second.nextCursor).toBeUndefined()
    expect((await new SkillsClient(client).list()).skills).toHaveLength(150)

    await client.close()
  })

  test('should take a listing and a file read from the token read budget', async () => {
    const endpoint = await bootEndpoint({ rateLimit: { max: 2 }, skills: { files: () => skillsModule() } })
    const client = await endpoint.connect('modern')
    const skills = new SkillsClient(client)

    await skills.list()
    await client.readResource({ uri: 'skill://refunds/SKILL.md' })

    await expect(client.readResource({ uri: 'skill://refunds/references/policy.md' })).rejects.toThrow('Rate limit exceeded')
    await expect(skills.get('skill://refunds/SKILL.md')).rejects.toThrow('Rate limit exceeded')
    await expect(client.listResources()).rejects.toThrow('Rate limit exceeded')

    await client.close()
  })

  test('should take skills/get and resources/list from the same budget', async () => {
    const endpoint = await bootEndpoint({ rateLimit: { max: 2 }, skills: { files: () => skillsModule() } })
    const client = await endpoint.connect('modern')
    const skills = new SkillsClient(client)

    await skills.get('skill://refunds/SKILL.md')
    await client.listResources()

    await expect(skills.list()).rejects.toThrow('Rate limit exceeded')

    await client.close()
  })
})
