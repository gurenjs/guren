import { describe, expect, it } from 'bun:test'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CATALOG_INPUTS,
  assertCommandsAndFlags,
  assertMinCli,
  assertPortableManifest,
  assertTargets,
  changesetNames,
  claudePluginValidate,
  renderCatalog,
  schemaIdentityProblems,
  validateAgainstSchema,
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

  it('attributes flags per invocation when several share a line', async () => {
    // --target belongs to agent:init, not to check; a greedy rest-of-line
    // capture would blame check for a flag it never declared
    expect(await assertCommandsAndFlags(md('x.md', '`guren check && guren agent:init --target codex`'))).toEqual([])
    const bad = await assertCommandsAndFlags(md('x.md', '`guren check --target codex && guren agent:init`'))
    expect(bad).toHaveLength(1)
    expect(bad[0]).toContain('check')
  })

  it('accepts the root --version probe the harness skill relies on', async () => {
    expect(await assertCommandsAndFlags(md('x.md', 'Run `bunx guren --version` first.'))).toEqual([])
  })
})

describe('audit: changeset gate parser', () => {
  it('reads a quoted key', () => {
    expect(changesetNames('---\n"@guren/cli": minor\n---\n\nbody\n', '@guren/cli')).toBe(true)
  })
  it('reads an unquoted key', () => {
    expect(changesetNames('---\n@guren/cli: patch\n---\n\nbody\n', '@guren/cli')).toBe(true)
  })
  it('reads a key that is not first', () => {
    expect(changesetNames('---\n"@guren/orm": minor\n"@guren/cli": patch\n---\n', '@guren/cli')).toBe(true)
  })
  it('does not count a mention in the Markdown body', () => {
    expect(changesetNames('---\n"@guren/orm": minor\n---\n\nSee "@guren/cli": it is unaffected.\n', '@guren/cli')).toBe(false)
  })
  it('does not count a different package', () => {
    expect(changesetNames('---\n"@guren/cli-extras": minor\n---\n', '@guren/cli')).toBe(false)
  })
  it('the gate watches every file renderCatalog reads', () => {
    // LICENSE is copied into the payload and the schema drives validation;
    // both were once missing from this list, which let a change to either
    // publish under an unchanged version
    expect(CATALOG_INPUTS).toContain('LICENSE')
    expect(CATALOG_INPUTS.some((i) => i.startsWith('packages/cli/templates/agent-catalog'))).toBe(true)
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

const PORTABLE_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'

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
  it("fails on a name that violates the schema's own pattern", async () => {
    for (const bad of ['Guren', 'guren--skills', 'guren..skills', '-guren', 'guren.', 'a'.repeat(65), '']) {
      const problems = await assertPortableManifest(rootManifest({ ...valid, name: bad }))
      expect(problems.some((p) => p.includes('plugin.json.name'))).toBe(true)
    }
  })
  it("accepts every valid name shape, including mixed separators the spec's pattern admits", async () => {
    // a-.b is valid per the schema (only -- and .. are forbidden); a stricter
    // hand-written regex used to reject it
    for (const ok of ['my-plugin', 'acme.tools', 'lint3r', 'a', 'a-.b', 'a.-b']) {
      expect(await assertPortableManifest(rootManifest({ ...valid, name: ok }))).toEqual([])
    }
  })
  it('enforces field types the schema declares, not just top-level keys', async () => {
    const problems = await assertPortableManifest(rootManifest({ ...valid, keywords: ['ok', 42] }))
    expect(problems.some((p) => p.includes('keywords[1]'))).toBe(true)
    const author = await assertPortableManifest(rootManifest({ ...valid, author: { name: 'x', twitter: '@x' } }))
    expect(author.some((p) => p.includes('author') && p.includes('twitter'))).toBe(true)
    const version = await assertPortableManifest(rootManifest({ ...valid, version: 1 }))
    expect(version.some((p) => p.includes('plugin.json.version'))).toBe(true)
  })
  it('fails on an extensions namespace that is not an object — a schema-valued additionalProperties', async () => {
    // the vendored schema constrains each namespace with `{"type":"object"}`
    // rather than with `false`, so a validator that only understands the
    // boolean form waves this through
    const problems = await assertPortableManifest(rootManifest({ ...valid, extensions: { 'com.example': 42 } }))
    expect(problems.some((p) => p.includes('extensions') && p.includes('com.example'))).toBe(true)
    expect(await assertPortableManifest(rootManifest({ ...valid, extensions: { 'com.example': {} } }))).toEqual([])
  })
  it('refuses to validate against a vendored schema that is no longer the spec schema', () => {
    // `{}` is itself a valid JSON Schema that accepts every document, so a
    // gutted or truncated vendored copy would turn this rule green, not red
    expect(schemaIdentityProblems({})).not.toEqual([])
    expect(schemaIdentityProblems({ $id: PORTABLE_SCHEMA_ID, required: ['$schema', 'name'], additionalProperties: true })).toEqual([
      'plugin.schema.json: the root is no longer a closed schema',
    ])
    expect(
      schemaIdentityProblems({ $id: PORTABLE_SCHEMA_ID, required: ['$schema', 'name'], additionalProperties: false }),
    ).toEqual([])
  })
  it('validateAgainstSchema is driven by the schema, so an upstream change is honored', () => {
    // a schema that adds a constraint is enforced without touching this file
    expect(validateAgainstSchema({ name: 'a' }, { type: 'object', properties: { name: { type: 'string', minLength: 3 } } })).toEqual([
      'plugin.json.name: shorter than 3',
    ])
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
