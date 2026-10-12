// Mirrors create-guren-app's own choices (packages/create-app/src/blueprints.ts
// and cli.ts); tests/lib/start-command.test.ts reads those sources and fails
// when a list or a flag name drifts.
export const BLUEPRINTS = ['default', 'blog', 'api', 'worker'] as const
export const RENDERING_MODES = ['ssr', 'spa'] as const
export const DATABASES = ['sqlite', 'postgres', 'mysql'] as const
export const AGENTS = ['claude', 'codex', 'cursor', 'copilot', 'opencode'] as const

export type Blueprint = (typeof BLUEPRINTS)[number]
export type RenderingMode = (typeof RENDERING_MODES)[number]
export type Database = (typeof DATABASES)[number]
export type Agent = (typeof AGENTS)[number]

export interface StartOptions {
  name: string
  blueprint: Blueprint
  mode: RenderingMode
  db: Database
  auth: boolean
  agents: Agent[]
  git: boolean
}

export const DEFAULT_PROJECT_NAME = 'my-app'

export const DEFAULT_START_OPTIONS: StartOptions = {
  name: DEFAULT_PROJECT_NAME,
  blueprint: 'default',
  mode: 'ssr',
  db: 'sqlite',
  auth: false,
  agents: ['claude'],
  git: true,
}

interface AgentDetail {
  label: string
  /** Run inside the new app, so the agent loads the harness written there. */
  launch: string
  /** Where to paste the prompt once `launch` has run, for agents that open an editor. */
  where?: string
  entry: string
}

export const AGENT_DETAILS: Record<Agent, AgentDetail> = {
  claude: { label: 'Claude Code', launch: 'claude', entry: 'CLAUDE.md' },
  codex: { label: 'Codex', launch: 'codex', entry: 'AGENTS.md' },
  cursor: { label: 'Cursor', launch: 'cursor .', where: 'the Agent panel', entry: 'AGENTS.md' },
  copilot: { label: 'GitHub Copilot', launch: 'code .', where: 'Copilot Chat in Agent mode', entry: 'AGENTS.md' },
  opencode: { label: 'OpenCode', launch: 'opencode', entry: 'AGENTS.md' },
}

// The name lands unquoted in a shell command and becomes a directory and a
// package name, so anything outside this set falls back to the default.
const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME.test(name)
}

function pick<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

function parseAgents(value: unknown): Agent[] {
  if (typeof value !== 'string') return DEFAULT_START_OPTIONS.agents
  if (value === 'none') return []
  const agents = AGENTS.filter((agent) => value.split(',').includes(agent))
  return agents.length > 0 ? agents : DEFAULT_START_OPTIONS.agents
}

/** Reads `/start?…`, falling back per field so a stale or hand-edited link still renders. */
export function startOptionsFromQuery(query: Record<string, unknown>): StartOptions {
  const name = typeof query.name === 'string' && isValidProjectName(query.name) ? query.name : DEFAULT_PROJECT_NAME
  return {
    name,
    blueprint: pick(BLUEPRINTS, query.blueprint, DEFAULT_START_OPTIONS.blueprint),
    mode: pick(RENDERING_MODES, query.mode, DEFAULT_START_OPTIONS.mode),
    db: pick(DATABASES, query.db, DEFAULT_START_OPTIONS.db),
    auth: flag(query.auth, DEFAULT_START_OPTIONS.auth),
    agents: parseAgents(query.agents),
    git: flag(query.git, DEFAULT_START_OPTIONS.git),
  }
}

/** The query string for the non-default choices, so a shared link stays short. */
export function startOptionsToQuery(options: StartOptions): string {
  const params = new URLSearchParams()
  if (options.name !== DEFAULT_START_OPTIONS.name) params.set('name', options.name)
  if (options.blueprint !== DEFAULT_START_OPTIONS.blueprint) params.set('blueprint', options.blueprint)
  if (options.mode !== DEFAULT_START_OPTIONS.mode) params.set('mode', options.mode)
  if (options.db !== DEFAULT_START_OPTIONS.db) params.set('db', options.db)
  if (options.auth !== DEFAULT_START_OPTIONS.auth) params.set('auth', options.auth ? '1' : '0')
  const agents = options.agents.length === 0 ? 'none' : options.agents.join(',')
  if (agents !== DEFAULT_START_OPTIONS.agents.join(',')) params.set('agents', agents)
  if (options.git !== DEFAULT_START_OPTIONS.git) params.set('git', options.git ? '1' : '0')
  // A comma is legal in a query value; leaving it unescaped keeps a shared link readable.
  return params.toString().replaceAll('%2C', ',')
}

/** The api blueprint renders no pages, so the rendering mode does not apply to it. */
export function hasRenderingMode(blueprint: Blueprint): boolean {
  return blueprint !== 'api'
}

/** blog ships sign-in already, and api has no pages to sign in on: create-guren-app ignores --auth for both. */
export function offersAuth(blueprint: Blueprint): boolean {
  return blueprint === 'default' || blueprint === 'worker'
}

export function usesDatabaseContainer(db: Database): boolean {
  return db !== 'sqlite'
}

/**
 * Every choice create-guren-app would otherwise prompt for is spelled out:
 * run where stdin is not a terminal (an agent's shell), the scaffolder takes
 * its defaults silently instead of asking.
 */
export function buildCreateCommand(options: StartOptions): string {
  const parts = ['bunx', 'create-guren-app', options.name]
  if (options.blueprint !== 'default') parts.push('--blueprint', options.blueprint)
  if (hasRenderingMode(options.blueprint)) parts.push('--mode', options.mode)
  parts.push('--db', options.db)
  if (offersAuth(options.blueprint) && options.auth) parts.push('--auth')
  parts.push('--agents', options.agents.length === 0 ? 'none' : options.agents.join(','))
  parts.push(options.git ? '--git' : '--no-git')
  return parts.join(' ')
}

/** Setup inside the new directory before the first `bun run dev`, per create-guren-app's README for each blueprint. */
export function buildSetupSteps(options: StartOptions): string[] {
  const steps: string[] = []
  if (usesDatabaseContainer(options.db)) steps.push('bun run db:up')
  if (options.blueprint === 'blog') {
    steps.push('bun run db:make', 'bun run db:migrate', 'bun run db:seed')
  } else if (offersAuth(options.blueprint) && options.auth) {
    // `guren add auth` writes its own migration during scaffolding.
    steps.push('bun run db:migrate')
  }
  return steps
}

export function buildNextSteps(options: StartOptions): string[] {
  return [`cd ${options.name}`, ...buildSetupSteps(options), 'bun run dev']
}

export function buildAgentPrompt(options: StartOptions, agent: Agent, goal = ''): string {
  const { entry } = AGENT_DETAILS[agent]
  const setup = buildSetupSteps(options)
  const lines = [
    `This is a new Guren app, scaffolded with \`${buildCreateCommand(options)}\`.`,
    '',
    `1. Read ${entry} and follow it for the rest of this session.`,
  ]
  let step = 2
  if (setup.length > 0) {
    const commands = setup.map((s) => (s === 'bun run db:up' ? '`bun run db:up` (Docker must be running)' : `\`${s}\``))
    lines.push(`${step}. Finish the setup: ${commands.join(', then ')}.`)
    step += 1
  }
  lines.push(
    `${step}. Run \`bunx guren gate\` and tell me whether every stage passes. If one fails, show me the output before changing anything.`,
    `${step + 1}. Run \`bunx guren context\` and describe the app in a few lines: its routes, models and pages.`,
    '',
    "Don't start the dev server; I'll run `bun run dev` myself.",
  )
  const trimmed = goal.trim()
  lines.push(
    trimmed
      ? `After that, I want to build this: ${trimmed}\nPropose a plan and wait for my approval before you write code.`
      : 'Then ask me what I want to build first.',
  )
  return lines.join('\n')
}
