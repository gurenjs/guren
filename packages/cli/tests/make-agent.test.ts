import { describe, it, expect } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { readApiOnlyTemplateFile } from './helpers'

import { makeAgent } from '../src/make-agent'
import { parseSourceFile } from '../src/parse-cache'
import {
  GENERATED_MODULE_COMPILER_OPTIONS,
  TSC_TIMEOUT,
  checkTypes,
  createTempWorkspace,
  writeWorkspaceFiles,
} from './helpers'

/**
 * `make:agent` writes the class and what a fresh app lacks for it: a class
 * nothing registers is inert, a class with no arch rule is one import away from
 * the second privileged path RFC 0017 exists to prevent, and a class naming an
 * `Env` nobody declares fails its first typecheck. Each case here is about one
 * of those, or about a patch this refuses to make silently.
 */

const repoRoot = resolve(import.meta.dir, '../../..')
const pluginAgentsDir = join(repoRoot, 'packages/plugin-agents')

/** The default starter's tsconfig as `create-guren-app` ships it — the multi-line `types` spelling. */
const readDefaultTemplateTsconfig = (): Promise<string> =>
  readFile(join(repoRoot, 'packages/create-app/templates/default/tsconfig.json'), 'utf8')

async function inWorkspace<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const workspace = await createTempWorkspace('guren-make-agent-')
  try {
    return await run(workspace.dir)
  } finally {
    await workspace.cleanup()
  }
}

const read = (dir: string, file: string): Promise<string> => readFile(join(dir, file), 'utf8')

describe('makeAgent', () => {
  it('writes a class that imports GurenAgent from the workerd-only entry', async () => {
    await inWorkspace(async (dir) => {
      const result = await makeAgent('Triager', { cwd: dir })
      const source = await read(dir, 'app/Agents/Triager.ts')

      expect(result.file).toContain('app/Agents/Triager.ts')
      // The root entry cannot be imported here: it is what `src/app.ts`
      // imports on Bun, and `agents` cannot evaluate outside workerd.
      expect(source).toContain("import { GurenAgent } from '@guren/plugin-agents/agent'")
      expect(source).toContain('export class Triager extends GurenAgent<Env, TriagerState>')
      expect(source).toContain('this.tools.call(')
      expect(parseSourceFile(source, 'Triager.ts')).not.toBeNull()
    })
  })

  it('creates config/agents.ts with the registration when the project has none', async () => {
    await inWorkspace(async (dir) => {
      const result = await makeAgent('Triager', { cwd: dir })
      const config = await read(dir, 'config/agents.ts')

      expect(result.patches).toContainEqual({ file: 'config/agents.ts', status: 'created' })
      expect(config).toContain("module: 'app/Agents/Triager.ts'")
      expect(config).toContain("export: 'Triager'")
      expect(config).toContain("scopes: ['tools:read']")
      expect(parseSourceFile(config, 'agents.ts')).not.toBeNull()
    })
  })

  it('inserts into an existing registry rather than replacing it', async () => {
    await inWorkspace(async (dir) => {
      await makeAgent('Triager', { cwd: dir })
      const result = await makeAgent('Reporter', { cwd: dir })
      const config = await read(dir, 'config/agents.ts')

      expect(result.patches).toContainEqual({ file: 'config/agents.ts', status: 'patched' })
      expect(config).toContain('triager: {')
      expect(config).toContain('reporter: {')
      expect(parseSourceFile(config, 'agents.ts')).not.toBeNull()
    })
  })

  it('leaves an agent that is already registered alone', async () => {
    await inWorkspace(async (dir) => {
      await makeAgent('Triager', { cwd: dir })
      const result = await makeAgent('Triager', { cwd: dir, force: true })

      expect(result.patches).toContainEqual({
        file: 'config/agents.ts',
        status: 'skipped',
        reason: '`triager` is already registered',
      })
      expect((await read(dir, 'config/agents.ts')).match(/triager: \{/gu)).toHaveLength(1)
    })
  })

  it('refuses a registry outside the static grammar and hands back the snippet', async () => {
    await inWorkspace(async (dir) => {
      // Valid TypeScript that `guren cloudflare:build` cannot read: the
      // registry is assembled at runtime, so no source path is recoverable.
      await Bun.write(
        join(dir, 'config/agents.ts'),
        `import { defineAgentsConfig } from '@guren/plugin-agents'\n`
        + `import { registry } from './registry'\n\n`
        + `export default defineAgentsConfig({ agents: registry })\n`,
      )

      const result = await makeAgent('Triager', { cwd: dir })
      const patch = result.patches.find((entry) => entry.file === 'config/agents.ts')

      expect(patch?.status).toBe('refused')
      if (patch?.status !== 'refused') return
      expect(patch.reason).toContain('literal `agents` object')
      expect(patch.snippet).toContain("export: 'Triager'")
      // Refused means untouched, not half-written.
      expect(await read(dir, 'config/agents.ts')).not.toContain('Triager')
    })
  })

  it('creates guren.arch.ts with the agent boundary when the project has none', async () => {
    await inWorkspace(async (dir) => {
      const result = await makeAgent('Triager', { cwd: dir })
      const arch = await read(dir, 'guren.arch.ts')

      expect(result.patches).toContainEqual({ file: 'guren.arch.ts', status: 'created' })
      expect(arch).toContain("from: 'app/Agents/**'")
      expect(arch).toContain("disallow: ['app/Models/**', 'db/**']")
      expect(arch).toContain("disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime']")
      expect(parseSourceFile(arch, 'guren.arch.ts')).not.toBeNull()
    })
  })

  it('inserts the boundary into an existing rules array', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(
        join(dir, 'guren.arch.ts'),
        `import { defineArchRules } from '@guren/cli/arch'\n\n`
        + `export default defineArchRules({\n`
        + `  rules: [\n`
        + `    { from: 'app/Domain/**', disallow: ['app/Http/**'] },\n`
        + `  ],\n`
        + `})\n`,
        'utf8',
      )

      const result = await makeAgent('Triager', { cwd: dir })
      const arch = await read(dir, 'guren.arch.ts')

      expect(result.patches).toContainEqual({ file: 'guren.arch.ts', status: 'patched' })
      expect(arch).toContain("from: 'app/Domain/**'")
      expect(arch).toContain("from: 'app/Agents/**'")
      expect(parseSourceFile(arch, 'guren.arch.ts')).not.toBeNull()
    })
  })

  it('patches a rules array written as const', async () => {
    // `rules: [ … ] as const` is a real spelling in a typed arch config, and a
    // bare shape test reads it as "no rules array" — so this refused to patch a
    // file it understands perfectly well.
    await inWorkspace(async (dir) => {
      await writeFile(
        join(dir, 'guren.arch.ts'),
        `import { defineArchRules } from '@guren/cli/arch'\n\n`
        + `export default defineArchRules({\n`
        + `  rules: [\n`
        + `    { from: 'app/Domain/**', disallow: ['app/Http/**'] },\n`
        + `  ] as const,\n`
        + `})\n`,
        'utf8',
      )

      const result = await makeAgent('Triager', { cwd: dir })
      const arch = await read(dir, 'guren.arch.ts')

      expect(result.patches).toContainEqual({ file: 'guren.arch.ts', status: 'patched' })
      expect(arch).toContain("from: 'app/Agents/**'")
      expect(arch).toContain('] as const,')
      expect(parseSourceFile(arch, 'guren.arch.ts')).not.toBeNull()
    })
  })

  it('inserts into a registry whose default export is wrapped in satisfies', async () => {
    await inWorkspace(async (dir) => {
      await writeWorkspaceFiles(dir, {
        'config/agents.ts':
          `import { defineAgentsConfig, type AgentsConfig } from '@guren/plugin-agents'\n\n`
          + `export default defineAgentsConfig({\n`
          + `  agents: {\n`
          + `    reporter: { module: 'app/Agents/Reporter.ts', export: 'Reporter', scopes: [] },\n`
          + `  },\n`
          + `}) satisfies AgentsConfig\n`,
      })

      const result = await makeAgent('Triager', { cwd: dir })
      const config = await read(dir, 'config/agents.ts')

      expect(result.patches).toContainEqual({ file: 'config/agents.ts', status: 'patched' })
      expect(config).toContain('triager: {')
      expect(config).toContain('reporter: {')
      expect(parseSourceFile(config, 'agents.ts')).not.toBeNull()
    })
  })

  it('skips a project whose existing rule already covers the whole boundary', async () => {
    await inWorkspace(async (dir) => {
      // A hand-written rule that forbids everything the scaffolded one does.
      // The project has made this decision; appending a duplicate would be
      // noise.
      await writeFile(
        join(dir, 'guren.arch.ts'),
        `import { defineArchRules } from '@guren/cli/arch'\n\n`
        + `export default defineArchRules({\n`
        + `  rules: [\n`
        + `    {\n`
        + `      from: 'app/Agents/**',\n`
        + `      disallow: ['app/Models/**', 'db/**', 'app/Services/**'],\n`
        + `      disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime'],\n`
        + `    },\n`
        + `  ],\n`
        + `})\n`,
        'utf8',
      )

      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.patches).toContainEqual({
        file: 'guren.arch.ts',
        status: 'skipped',
        reason: 'a rule for `app/Agents/**` already forbids everything this one would',
      })
      expect(await read(dir, 'guren.arch.ts')).toContain("app/Services/**")
    })
  })

  for (const [label, rule] of [
    ['only warns', "{ from: 'app/Agents/**', disallow: ['app/Models/**', 'db/**'], disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime'], severity: 'warn' }"],
    ['omits db/**', "{ from: 'app/Agents/**', disallow: ['app/Models/**'], disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime'] }"],
    ['omits the runtime seam', "{ from: 'app/Agents/**', disallow: ['app/Models/**', 'db/**'], disallowPackages: ['@guren/orm'] }"],
  ] as Array<[string, string]>) {
    it(`adds the boundary beside an existing app/Agents rule that ${label}`, async () => {
      // A rule that names `app/Agents/**` but stops nothing the boundary is
      // for reads as coverage and is not. Arch rules are additive and judged
      // independently, so the honest fix is to add the real one beside it.
      await inWorkspace(async (dir) => {
        await writeFile(
          join(dir, 'guren.arch.ts'),
          `import { defineArchRules } from '@guren/cli/arch'\n\n`
          + `export default defineArchRules({\n  rules: [\n    ${rule},\n  ],\n})\n`,
          'utf8',
        )

        const result = await makeAgent('Triager', { cwd: dir })
        const arch = await read(dir, 'guren.arch.ts')

        expect(result.patches).toContainEqual({ file: 'guren.arch.ts', status: 'patched' })
        expect(arch).toContain("disallowPackages: ['@guren/orm', '@guren/plugin-agents/runtime']")
        expect(parseSourceFile(arch, 'guren.arch.ts')).not.toBeNull()
      })
    })
  }

  it('imports Env from config/env.ts and writes that file when the project has none', async () => {
    await inWorkspace(async (dir) => {
      const result = await makeAgent('Triager', { cwd: dir })
      const source = await read(dir, 'app/Agents/Triager.ts')
      const env = await read(dir, 'config/env.ts')

      // `@cloudflare/workers-types` declares `Cloudflare.Env`, never a bare
      // `Env`, so the class has to import the one the app defines.
      expect(source).toContain("import type { Env } from '@/config/env'")
      expect(result.patches).toContainEqual({ file: 'config/env.ts', status: 'created' })
      expect(env).toContain('export interface Env {')
      expect(env).toContain('DB: unknown')
      // The binding slot uses the name `guren cloudflare:build` would bind the class under.
      expect(env).toContain('// TRIAGER?: {')
      expect(parseSourceFile(env, 'env.ts')).not.toBeNull()
    })
  })

  for (const [label, handWritten] of [
    ['declares Env', 'export interface Env {\n  DB: unknown\n  QUEUE: unknown\n}\n'],
    ['re-exports Env', "export type { Env } from './bindings'\n"],
  ] as Array<[string, string]>) {
    it(`leaves an existing config/env.ts alone when it ${label}`, async () => {
      await inWorkspace(async (dir) => {
        await writeWorkspaceFiles(dir, { 'config/env.ts': handWritten })

        const result = await makeAgent('Triager', { cwd: dir })

        expect(result.patches).toContainEqual({
          file: 'config/env.ts',
          status: 'skipped',
          reason: 'it already exports `Env`',
        })
        expect(await read(dir, 'config/env.ts')).toBe(handWritten)
      })
    })
  }

  it('refuses a config/env.ts that exports no Env and hands back the interface', async () => {
    await inWorkspace(async (dir) => {
      const other = 'export interface Bindings {\n  DB: unknown\n}\n'
      await writeWorkspaceFiles(dir, { 'config/env.ts': other })

      const result = await makeAgent('Triager', { cwd: dir })
      const patch = result.patches.find((entry) => entry.file === 'config/env.ts')

      expect(patch?.status).toBe('refused')
      if (patch?.status !== 'refused') return
      expect(patch.reason).toContain('exports no `Env`')
      expect(patch.snippet).toContain('export interface Env {')
      expect(await read(dir, 'config/env.ts')).toBe(other)
    })
  })

  for (const [label, readTemplate, from, to] of [
    [
      'the default starter’s multi-line types array',
      readDefaultTemplateTsconfig,
      '      "vite/client"\n',
      '      "vite/client",\n      "@cloudflare/workers-types"\n',
    ],
    [
      'the api-only starter’s single-line types array',
      () => readApiOnlyTemplateFile('tsconfig.json'),
      '"types": ["bun-types"]',
      '"types": ["bun-types", "@cloudflare/workers-types"]',
    ],
    [
      'the compilerOptions types array, not a types key under paths',
      async () => '{\n  "compilerOptions": {\n    "paths": { "types": ["./types"] },\n    "types": ["bun-types"]\n  }\n}\n',
      '"types": ["bun-types"]',
      '"types": ["bun-types", "@cloudflare/workers-types"]',
    ],
  ] as Array<[string, () => Promise<string>, string, string]>) {
    it(`appends the Workers types to ${label} and leaves the rest byte-identical`, async () => {
      await inWorkspace(async (dir) => {
        const before = await readTemplate()
        // The fixture has to carry the spelling the case is about, or the
        // replace below is a no-op and the assertion passes on an untouched file.
        expect(before).toContain(from)
        await writeWorkspaceFiles(dir, { 'tsconfig.json': before })

        const result = await makeAgent('Triager', { cwd: dir })

        expect(result.patches).toContainEqual({ file: 'tsconfig.json', status: 'patched' })
        expect(await read(dir, 'tsconfig.json')).toBe(before.replace(from, to))
      })
    })
  }

  it('skips a tsconfig whose types already name the Workers types', async () => {
    await inWorkspace(async (dir) => {
      const before = '{\n  "compilerOptions": {\n    "types": ["bun-types", "@cloudflare/workers-types"]\n  }\n}\n'
      await writeWorkspaceFiles(dir, { 'tsconfig.json': before })

      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.patches).toContainEqual({
        file: 'tsconfig.json',
        status: 'skipped',
        reason: 'its `types` already names @cloudflare/workers-types',
      })
      expect(await read(dir, 'tsconfig.json')).toBe(before)
    })
  })

  for (const [label, tsconfig, reason] of [
    ['has no types array', '{\n  "compilerOptions": {\n    "strict": true\n  }\n}\n', 'no compilerOptions.types array'],
    ['carries comments', '{\n  // wrangler wrote this\n  "compilerOptions": {\n    "types": ["bun-types"]\n  }\n}\n', 'not strict JSON'],
  ] as Array<[string, string, string]>) {
    it(`refuses a tsconfig that ${label} and prints the line to add`, async () => {
      await inWorkspace(async (dir) => {
        await writeWorkspaceFiles(dir, { 'tsconfig.json': tsconfig })

        const result = await makeAgent('Triager', { cwd: dir })
        const patch = result.patches.find((entry) => entry.file === 'tsconfig.json')

        expect(patch?.status).toBe('refused')
        if (patch?.status !== 'refused') return
        expect(patch.reason).toContain(reason)
        expect(patch.snippet).toBe('"types": ["bun-types", "@cloudflare/workers-types"]')
        expect(await read(dir, 'tsconfig.json')).toBe(tsconfig)
      })
    })
  }

  it('reports a missing tsconfig.json rather than creating one', async () => {
    await inWorkspace(async (dir) => {
      const result = await makeAgent('Triager', { cwd: dir })
      const patch = result.patches.find((entry) => entry.file === 'tsconfig.json')

      expect(patch?.status).toBe('refused')
      if (patch?.status !== 'refused') return
      expect(patch.reason).toContain('none at the project root')
    })
  })

  it('spells the Durable Object binding name the way guren cloudflare:build does', async () => {
    // Two copies on purpose: `@guren/cli` does not depend on
    // `@guren/plugin-cloudflare`, and the rule feeds only a commented slot here,
    // so nothing typechecks the two against each other. Pinned as source text.
    const body = /function durableObjectBindingName\([^)]*\): string \{\n([\s\S]*?)\n\}/u
    const here = body.exec(await readFile(join(repoRoot, 'packages/cli/src/make-agent.ts'), 'utf8'))
    const there = body.exec(await readFile(join(repoRoot, 'packages/plugin-cloudflare/src/build.ts'), 'utf8'))

    expect(here?.[1]).toBeDefined()
    expect(here?.[1]).toBe(there?.[1] as string)
  })

  it(
    'scaffolds a class that typechecks against @guren/plugin-agents as written',
    async () => {
      await inWorkspace(async (dir) => {
        await makeAgent('Triager', { cwd: dir })

        // What a fresh app's tsconfig has once the command has run: the `@/`
        // alias, the plugin, and `@cloudflare/workers-types` in `types`. The
        // plugin is compiled from source, so this fails when its generics move.
        const workersTypes = Bun.resolveSync('@cloudflare/workers-types/package.json', pluginAgentsDir)
        const diagnostics = checkTypes([join(dir, 'app/Agents/Triager.ts')], {
          ...GENERATED_MODULE_COMPILER_OPTIONS,
          lib: ['es2022'],
          types: ['@cloudflare/workers-types'],
          typeRoots: [resolve(dirname(workersTypes), '../..')],
          paths: {
            '@/*': [join(dir, '*')],
            '@guren/plugin-agents/agent': [join(pluginAgentsDir, 'src/agent.ts')],
          },
        })

        expect(diagnostics).toEqual([])
      })
    },
    TSC_TIMEOUT,
  )

  it('tells the user to install the plugin when the app does not depend on it', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.notes.join('\n')).toContain('guren plugin @guren/plugin-agents')
    })
  })

  it('tells the user to add the Workers types when the app does not depend on them', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@guren/plugin-agents': '^0.1.0' } }),
        'utf8',
      )
      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.notes).toEqual([expect.stringContaining('bun add -d @cloudflare/workers-types')])
    })
  })

  it('stays quiet when the app already depends on the plugin and the Workers types', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({
          dependencies: { '@guren/plugin-agents': '^0.1.0' },
          devDependencies: { '@cloudflare/workers-types': '^4.0.0' },
        }),
        'utf8',
      )
      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.notes).toEqual([])
    })
  })

  it('refuses --module rather than scaffolding a registry the build never reads', async () => {
    await inWorkspace(async (dir) => {
      await expect(makeAgent('Triager', { cwd: dir, root: 'billing' })).rejects.toThrow(
        /does not support --module/,
      )
    })
  })
})
