import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertCommandsAndFlags,
  assertMinCli,
  assertPortableManifest,
  assertTargets,
  claudePluginValidate,
  renderCatalog,
  writeCatalog,
} from './build-agent-catalog.ts'

/**
 * The audit exists to fail. Every rule below is pinned in both directions: it
 * passes on the real rendered payload, and it fails on a synthetic file that
 * carries exactly the defect the rule claims to catch. A rule that only had
 * the positive half would be indistinguishable from one that checks nothing.
 */

const md = (path: string, content: string) => [{ path, content }]

describe('renderCatalog', () => {
  it('renders the full published tree with no token left behind', async () => {
    const files = await renderCatalog()
    const paths = files.map((f) => f.path).sort()
    expect(paths).toEqual(
      [
        '.claude-plugin/marketplace.json',
        'CONTRIBUTING.md',
        'LICENSE',
        'README.md',
        'plugins/guren/.claude-plugin/plugin.json',
        'plugins/guren/LICENSE',
        'plugins/guren/README.md',
        'plugins/guren/plugin.json',
        'plugins/guren/skills/guren-harness/SKILL.md',
        'plugins/guren/skills/guren-new-app/SKILL.md',
      ].sort(),
    )
    for (const file of files) {
      expect(file.content).not.toMatch(/__[A-Z][A-Z_]*__/u)
    }
  })

  it('renders one manifest template into both locations, differing only by $schema', async () => {
    const files = await renderCatalog()
    const root = JSON.parse(files.find((f) => f.path === 'plugins/guren/plugin.json')!.content)
    const claude = JSON.parse(files.find((f) => f.path === 'plugins/guren/.claude-plugin/plugin.json')!.content)
    expect(root.$schema).toBe('https://agent-plugins.org/schemas/1.0.0/plugin.schema.json')
    expect(claude.$schema).toBeUndefined()
    const { $schema: _s, ...rest } = root
    expect(claude).toEqual(rest)
  })

  it('the plugin version is the workspace @guren/cli version', async () => {
    const files = await renderCatalog()
    const cli = (await Bun.file(new URL('../packages/cli/package.json', import.meta.url)).json()) as { version: string }
    const root = JSON.parse(files.find((f) => f.path === 'plugins/guren/plugin.json')!.content)
    const market = JSON.parse(files.find((f) => f.path === '.claude-plugin/marketplace.json')!.content)
    expect(root.version).toBe(cli.version)
    expect(market.plugins[0].version).toBe(cli.version)
  })

  it('the pre-app skill never invokes bunx guren before an app exists', async () => {
    // the whole point of guren-new-app: `guren` is not on npm, so every
    // `bunx guren` line must come after the scaffold + postcondition section
    const files = await renderCatalog()
    const skill = files.find((f) => f.path.endsWith('guren-new-app/SKILL.md'))!.content
    const handoff = skill.indexOf('## Check the postcondition')
    expect(handoff).toBeGreaterThan(0)
    const before = skill.slice(0, handoff)
    // the only allowed mention before the postcondition is the explicit "do not run" warning
    const invocations = [...before.matchAll(/bunx guren [a-z]/gu)].map((m) => m[0])
    expect(invocations).toEqual([])
  })
})

describe('audit: commands and flags', () => {
  it('passes on the real payload', async () => {
    expect(await assertCommandsAndFlags(await renderCatalog())).toEqual([])
  })

  it('fails on a command the CLI does not register', async () => {
    const problems = await assertCommandsAndFlags(md('x.md', 'Run `bunx guren agent:frobnicate` now.'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('agent:frobnicate')
  })

  it('fails on a bare `guren <cmd>` too — prose names commands without bunx', async () => {
    const problems = await assertCommandsAndFlags(md('x.md', 'Then run guren fooble and see.'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('fooble')
  })

  it('fails on a flag the named command does not declare', async () => {
    const problems = await assertCommandsAndFlags(md('x.md', '`bunx guren agent:init --yolo`'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('--yolo')
  })

  it('binds a flag to its command, not to the CLI as a whole', async () => {
    // --target is real on agent:init and absent on check; a flat "exists
    // somewhere" set would accept this
    const problems = await assertCommandsAndFlags(md('x.md', '`bunx guren check --target codex`'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('--target')
  })

  it('accepts flags the command does declare, and the universal --help', async () => {
    expect(await assertCommandsAndFlags(md('x.md', '`bunx guren agent:init --target codex --force` and `guren check --help`'))).toEqual([])
  })

  it('does not read prose after an inline span as flags', async () => {
    expect(await assertCommandsAndFlags(md('x.md', 'Use `guren check` — the --changed flag is optional prose here.'))).toEqual([])
  })
})

describe('audit: targets', () => {
  it('passes on the real payload', async () => {
    expect(assertTargets(await renderCatalog())).toEqual([])
  })
  it('fails on a target outside AGENT_TARGETS', () => {
    const problems = assertTargets(md('x.md', '`bunx guren agent:init --target codex,windsurf`'))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('windsurf')
  })
  it('accepts `all`', () => {
    expect(assertTargets(md('x.md', '`bunx guren agent:init --target all`'))).toEqual([])
  })
})

describe('audit: minimum CLI claim', () => {
  it('is not ahead of the workspace version', async () => {
    expect(await assertMinCli()).toEqual([])
  })
})

describe('audit: Agent Plugins v1 manifest', () => {
  const rootManifest = (obj: Record<string, unknown>) => [
    { path: 'plugins/guren/plugin.json', content: JSON.stringify(obj) },
  ]
  const valid = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'guren',
    version: '1.0.0',
  }

  it('passes on the real payload', async () => {
    expect(await assertPortableManifest(await renderCatalog())).toEqual([])
  })
  it('fails when $schema is missing (required by the spec)', async () => {
    const { $schema: _s, ...noSchema } = valid
    const problems = await assertPortableManifest(rootManifest(noSchema))
    expect(problems.some((p) => p.includes('$schema'))).toBe(true)
  })
  it('fails on an unknown top-level field — the schema is closed', async () => {
    const problems = await assertPortableManifest(rootManifest({ ...valid, mcpServers: {} }))
    expect(problems).toEqual(['plugin.json: field "mcpServers" is not permitted (closed schema)'])
  })
  it('fails on a name that violates the Agent Plugins name rule', async () => {
    for (const bad of ['Guren', 'guren--skills', '-guren', 'guren.', 'a'.repeat(65)]) {
      const problems = await assertPortableManifest(rootManifest({ ...valid, name: bad }))
      expect(problems.some((p) => p.includes('name rule'))).toBe(true)
    }
  })
  it('accepts every valid name shape the spec lists', async () => {
    for (const ok of ['my-plugin', 'acme.tools', 'lint3r', 'a']) {
      expect(await assertPortableManifest(rootManifest({ ...valid, name: ok }))).toEqual([])
    }
  })
  it('fails when the Claude copy diverges from the root beyond $schema', async () => {
    const problems = await assertPortableManifest([
      ...rootManifest(valid),
      { path: 'plugins/guren/.claude-plugin/plugin.json', content: JSON.stringify({ name: 'guren', version: '9.9.9' }) },
    ])
    expect(problems.some((p) => p.includes('differs from the root manifest'))).toBe(true)
  })
})

describe('claude plugin validate', () => {
  const haveClaude = Bun.spawnSync(['sh', '-c', 'command -v claude'], {}).success

  it.skipIf(!haveClaude)('passes on the real rendered payload — the community pipeline runs this same check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-catalog-test-'))
    try {
      await writeCatalog(dir)
      expect(await claudePluginValidate(dir)).toEqual({ kind: 'pass' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!haveClaude)('reports fail, not unavailable, when the manifest is broken', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'guren-catalog-test-'))
    try {
      await writeCatalog(dir)
      // an unrecognized field is what --strict turns from warning into error
      await writeFile(join(dir, 'plugins/guren/.claude-plugin/plugin.json'), JSON.stringify({ name: 'guren', bogusField: 1 }), 'utf8')
      const outcome = await claudePluginValidate(dir)
      expect(outcome.kind).toBe('fail')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
