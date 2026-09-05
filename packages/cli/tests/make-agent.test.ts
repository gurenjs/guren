import { describe, it, expect } from 'bun:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { makeAgent } from '../src/make-agent'
import { parseSourceFile } from '../src/parse-cache'
import { createTempWorkspace, writeWorkspaceFiles } from './helpers'

/**
 * `make:agent` writes three files, and the two beyond the class are what the
 * command is for: a class nothing registers is inert, and a class with no arch
 * rule is one import away from the second privileged path RFC 0017 exists to
 * prevent. Each case here is about one of those two, or about a patch this
 * refuses to make silently.
 */

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

  it('tells the user to install the plugin when the app does not depend on it', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies: {} }), 'utf8')
      const result = await makeAgent('Triager', { cwd: dir })

      expect(result.notes.join('\n')).toContain('guren plugin @guren/plugin-agents')
    })
  })

  it('stays quiet when the app already depends on the plugin', async () => {
    await inWorkspace(async (dir) => {
      await writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ dependencies: { '@guren/plugin-agents': '^0.1.0' } }),
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
