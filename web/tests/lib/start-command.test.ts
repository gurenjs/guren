import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AGENTS,
  BLUEPRINTS,
  DATABASES,
  DEFAULT_START_OPTIONS,
  RENDERING_MODES,
  buildAgentPrompt,
  buildCreateCommand,
  buildNextSteps,
  buildScaffoldPrompt,
  buildSkillInstallCommands,
  hasRenderingMode,
  offersAuth,
  startOptionsFromQuery,
  startOptionsToQuery,
  type StartOptions,
} from '../../resources/js/lib/start-command.js'

const repoRoot = resolve(import.meta.dirname, '../../..')
const read = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8')

function literalList(source: string, constName: string): string[] {
  const match = source.match(new RegExp(`const ${constName} = \\[([^\\]]+)\\] as const`, 'u'))
  if (!match) throw new Error(`No ${constName} literal found`)
  return [...match[1]!.matchAll(/'([a-z]+)'/gu)].map((entry) => entry[1]!)
}

function options(patch: Partial<StartOptions>): StartOptions {
  return { ...DEFAULT_START_OPTIONS, ...patch }
}

// The page and create-guren-app cannot share a module (the scaffolder is not a
// dependency of the site, and importing its cli.ts runs it), so its sources are
// read as text, as packages/create-app/tests/agent-choices-mirror.test.ts does.
describe('create-guren-app mirror', () => {
  const blueprints = read('packages/create-app/src/blueprints.ts')
  const cli = read('packages/create-app/src/cli.ts')

  it('offers exactly the blueprints, modes, databases and agents the scaffolder accepts', () => {
    expect([...BLUEPRINTS].sort()).toEqual(literalList(blueprints, 'APP_BLUEPRINTS').sort())
    expect([...DATABASES].sort()).toEqual(literalList(blueprints, 'DATABASE_DRIVERS').sort())
    expect([...RENDERING_MODES].sort()).toEqual(literalList(cli, 'RENDERING_MODES').sort())
    expect([...AGENTS]).toEqual(literalList(cli, 'AGENT_CHOICES'))
  })

  it('emits only flags the scaffolder declares', () => {
    const args = cli.slice(cli.indexOf('  args: {'), cli.indexOf('  async run('))
    const declared = new Set([...args.matchAll(/^ {4}([a-z]+): \{/gmu)].map((entry) => entry[1]!))
    const everything = options({ blueprint: 'worker', auth: true, agents: [...AGENTS] })
    const emitted = [buildCreateCommand(everything), buildCreateCommand(options({ git: false }))]
      .flatMap((command) => command.split(' '))
      .filter((word) => word.startsWith('--'))
      .map((word) => word.replace(/^--(no-)?/u, ''))
    expect(emitted.length).toBeGreaterThan(0)
    for (const name of emitted) expect(declared).toContain(name)
  })

  it('hides sign-in for the blueprints the scaffolder ignores --auth on', () => {
    const entry = (name: string) => {
      const start = blueprints.indexOf(`\n  ${name}: {`)
      if (start === -1) throw new Error(`No ${name} blueprint entry found`)
      return blueprints.slice(start, blueprints.indexOf('\n  },', start))
    }
    for (const name of BLUEPRINTS) {
      const block = entry(name)
      const ignoresAuth = /includesAuth: true|apiOnly: true/u.test(block)
      expect({ name, offersAuth: offersAuth(name) }).toEqual({ name, offersAuth: !ignoresAuth })
    }
    expect(hasRenderingMode('api')).toBe(!/apiOnly: true/u.test(entry('api')))
  })
})

describe('buildCreateCommand', () => {
  it('spells out every prompted choice for the defaults', () => {
    expect(buildCreateCommand(DEFAULT_START_OPTIONS)).toBe(
      'bunx create-guren-app my-app --mode ssr --db sqlite --agents claude --git',
    )
  })

  it('leaves out the rendering mode and sign-in for the api blueprint', () => {
    expect(buildCreateCommand(options({ blueprint: 'api', mode: 'spa', auth: true, git: false, agents: [] }))).toBe(
      'bunx create-guren-app my-app --blueprint api --db sqlite --agents none --no-git',
    )
  })

  it('leaves out --auth for blog, which ships sign-in already', () => {
    expect(buildCreateCommand(options({ blueprint: 'blog', auth: true }))).not.toContain('--auth')
  })

  it('keeps the scaffolder order of several agents', () => {
    expect(buildCreateCommand(options({ db: 'postgres', auth: true, agents: ['claude', 'cursor'] }))).toBe(
      'bunx create-guren-app my-app --mode ssr --db postgres --auth --agents claude,cursor --git',
    )
  })
})

describe('buildNextSteps', () => {
  it('runs the default app straight away', () => {
    expect(buildNextSteps(DEFAULT_START_OPTIONS)).toEqual(['cd my-app', 'bun run dev'])
  })

  it('starts the container, then migrates what sign-in added', () => {
    expect(buildNextSteps(options({ db: 'mysql', auth: true }))).toEqual([
      'cd my-app',
      'bun run db:up',
      'bun run db:migrate',
      'bun run dev',
    ])
  })

  it('generates, runs and seeds the blog migration', () => {
    expect(buildNextSteps(options({ blueprint: 'blog' }))).toEqual([
      'cd my-app',
      'bun run db:make',
      'bun run db:migrate',
      'bun run db:seed',
      'bun run dev',
    ])
  })
})

describe('buildAgentPrompt', () => {
  it('points each agent at the entry file its harness reads', () => {
    expect(buildAgentPrompt(DEFAULT_START_OPTIONS, 'claude')).toContain('Read CLAUDE.md')
    expect(buildAgentPrompt(options({ agents: ['codex'] }), 'codex')).toContain('Read AGENTS.md')
  })

  it('hands the database setup to the agent and keeps the dev server with the person', () => {
    const prompt = buildAgentPrompt(options({ db: 'postgres', auth: true }), 'claude')
    expect(prompt).toContain('Finish the setup: `bun run db:up` (Docker must be running), then `bun run db:migrate`.')
    expect(prompt).toContain('bunx guren gate')
    expect(prompt).toContain("Don't start the dev server")
  })

  it('asks for a plan before code when a goal is given', () => {
    expect(buildAgentPrompt(DEFAULT_START_OPTIONS, 'claude', '  a reading list  ')).toContain(
      'I want to build this: a reading list\nPropose a plan',
    )
    expect(buildAgentPrompt(DEFAULT_START_OPTIONS, 'claude')).toContain('ask me what I want to build first')
  })
})

describe('the agent-runs-it route', () => {
  it('installs the skills from the catalog the agent harness guide names', () => {
    const guide = read('docs/en/guides/agent-harness.md')
    for (const agent of AGENTS) {
      for (const command of buildSkillInstallCommands(agent)) expect(guide).toContain(command)
    }
    expect(buildSkillInstallCommands('claude')).toHaveLength(2)
    expect(buildSkillInstallCommands('codex')).toEqual(['npx skills add gurenjs/agent-skills'])
  })

  it('names the skill the catalog ships and hands over the exact command', () => {
    const skill = read('packages/cli/templates/agent-catalog/skills/guren-new-app/SKILL.md')
    expect(skill).toMatch(/^name: guren-new-app$/mu)
    const prompt = buildScaffoldPrompt(options({ db: 'mysql' }))
    expect(prompt).toContain('guren-new-app skill')
    expect(prompt).toContain(`\`${buildCreateCommand(options({ db: 'mysql' }))}\``)
  })
})

describe('query round trip', () => {
  it('writes nothing for the defaults', () => {
    expect(startOptionsToQuery(DEFAULT_START_OPTIONS)).toBe('')
    expect(startOptionsFromQuery({})).toEqual(DEFAULT_START_OPTIONS)
  })

  it('reads back what it writes', () => {
    const chosen = options({ name: 'shop', blueprint: 'worker', mode: 'spa', db: 'postgres', auth: true, agents: [], git: false })
    const query = Object.fromEntries(new URLSearchParams(startOptionsToQuery(chosen)))
    expect(startOptionsFromQuery(query)).toEqual(chosen)
  })

  it('keeps the agent list readable', () => {
    expect(startOptionsToQuery(options({ agents: ['claude', 'codex'] }))).toBe('agents=claude,codex')
  })

  it('falls back per field on values it does not know', () => {
    expect(
      startOptionsFromQuery({ name: 'My App; rm -rf ~', db: 'oracle', mode: 'spa', agents: 'emacs,codex' }),
    ).toEqual(options({ mode: 'spa', agents: ['codex'] }))
  })
})
