/**
 * The agent registry (RFC 0017 §3): `config/agents.ts`, the one file that says
 * which classes are agents, where they live, and what they may call.
 *
 * The grammar is static: `module` and `export` are literal strings because the
 * Cloudflare build reads this file *as source*, and a runtime class value
 * carries no source path. The runtime half, and Bun-safe.
 */
import { classifyRegistrationScope } from '@guren/core'
import type { AgentApprovalRequest, AgentApprovalStore } from '@guren/core'

/**
 * The per-instance meter every registered agent gets (RFC 0017 §4).
 *
 * Optional only in spelling: an agent with no `budget` gets
 * {@link DEFAULT_AGENT_CALLS_PER_MINUTE}. There is no unmetered registration.
 */
export interface AgentBudgetConfig {
  /**
   * Tool calls this agent instance may make in any 60-second window.
   * @default 60 ({@link DEFAULT_AGENT_CALLS_PER_MINUTE})
   */
  callsPerMinute?: number
}

/** One agent, as `config/agents.ts` declares it. */
export interface AgentRegistrationConfig {
  /** Project-relative path to the module holding the class, e.g. `app/Agents/Triager.ts`. */
  module: string
  /** The exported class name in that module, e.g. `Triager`. */
  export: string
  /**
   * What this agent may call, in the registration grammar: `tool:<name>` for
   * one tool by exact name, or `tools:read` for every read-only tool. Set
   * grants (`tools:*`, `tools:<prefix>.*`) are refused — see
   * `classifyRegistrationScope` in `@guren/server` for why an unattended
   * principal may not hold one.
   */
  scopes: string[]
  budget?: AgentBudgetConfig
}

/**
 * The approval queue, in the same shape `@guren/plugin-mcp` takes it.
 *
 * Opt-in with no default: a queue that fell back to process memory would answer
 * "approved" for a record the next isolate never saw. Unconfigured, an
 * `approval: 'required'` tool is refused fail-closed.
 */
export interface AgentsApprovalsConfig {
  store: AgentApprovalStore
  notify: (request: AgentApprovalRequest) => void | Promise<void>
  /** @default 1 hour (`DEFAULT_AGENT_APPROVAL_TTL_MS`) */
  ttlMs?: number
}

/** The instance a `/agents/<agent>/<instance>` request is addressed to. */
export interface AgentRouteTarget {
  /**
   * The Durable Object **binding** name the URL segment resolved to, not the
   * `config/agents.ts` key: the SDK builds its route table from `env`, and the
   * path segment is that binding kebab-cased (`TRIAGER_AGENT` → `triager-agent`).
   */
  agent: string
  /** The instance name — the second segment, passed to `idFromName`. */
  instance: string
}

/**
 * Who may address an agent instance.
 *
 * `true` lets the request reach the Durable Object; `false` refuses it with
 * 403; a `Response` is returned as it is; a throw propagates. The Durable
 * Object is constructed only on `true`, so a refusal costs no cold start.
 */
export type AgentRouteAuthorizer = (
  request: Request,
  target: AgentRouteTarget,
) => boolean | Response | Promise<boolean | Response>

/**
 * The documented override of the scaffolded deny-all (RFC 0017 §6).
 *
 * Deliberately thin — a predicate, not a policy class — because Open Question 3
 * (per-agent policy classes? `Gate` abilities?) is unsettled, and a richer
 * surface published now would have to be kept.
 */
export interface AgentsRoutingConfig {
  authorize: AgentRouteAuthorizer
}

export interface AgentsConfig {
  /**
   * Keyed by the agent's name — the half of its principal id that is not the
   * instance (`agent:<name>:<instance>`), and the key `guren check` reports
   * findings under.
   */
  agents: Record<string, AgentRegistrationConfig>
  approvals?: AgentsApprovalsConfig
  /**
   * Who may reach `/agents/*` on the generated worker. Absent, every request to
   * that prefix is refused and no Durable Object is constructed.
   */
  routing?: AgentsRoutingConfig
}

/** Calls per minute an agent instance gets when its registration names none. */
export const DEFAULT_AGENT_CALLS_PER_MINUTE = 60

/**
 * The characters an agent name may use.
 *
 * The name is half of `agent:<name>:<instance>`; a `:` in either half makes
 * `a:b`/`c` and `a`/`b:c` one string, so one agent could spend another's
 * approval. The instance half is encoded where it is used.
 */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * Identity function giving `config/agents.ts` type-checking and autocomplete,
 * the way `defineArchRules` does for `guren.arch.ts`.
 * @example
 * `defineAgentsConfig({ agents: { triager: { module, export, scopes } } })`
 */
export function defineAgentsConfig(config: AgentsConfig): AgentsConfig {
  return config
}

/** One thing wrong with a registration, addressed to the person who wrote it. */
export interface AgentsConfigProblem {
  /** The `agents` key the problem belongs to. */
  agent: string
  /** The offending scope entry, when the problem is about one. */
  scope?: string
  /** The reason and the fix, in one sentence. */
  message: string
}

/**
 * Check a config against the registration grammar.
 *
 * Returns problems rather than throwing: `agentsPlugin` turns them into a boot
 * failure, `guren check` into findings, and a throw gives it one message where
 * it needs all of them. Scope classification lives in `@guren/server`.
 */
export function validateAgentsConfig(config: AgentsConfig): AgentsConfigProblem[] {
  const problems: AgentsConfigProblem[] = []

  // Keyed by export name, because that is what the runtime registry is keyed
  // by and what the build appends as a named export. Two agents claiming one
  // class would silently make one of them unreachable in both places.
  const seenExports = new Map<string, string>()

  for (const [agent, registration] of Object.entries(config.agents ?? {})) {
    if (!AGENT_NAME_PATTERN.test(agent)) {
      problems.push({
        agent,
        message:
          `"${agent}" is not a usable agent name. The name is one half of the principal id `
          + `"agent:<name>:<instance>", so a colon or a space in it makes two different agents `
          + 'able to produce the same id — and an approval granted to one spendable by the other. '
          + 'Use letters, digits, underscores and hyphens.',
      })
    }

    if (typeof registration?.module !== 'string' || registration.module.trim() === '') {
      problems.push({
        agent,
        message:
          'The registration has no `module`. It must be a literal, project-relative path to the '
          + "file holding the class, e.g. 'app/Agents/Triager.ts'.",
      })
    }

    const exportName = registration?.export
    if (typeof exportName !== 'string' || exportName.trim() === '') {
      problems.push({
        agent,
        message:
          'The registration has no `export`. It must be the literal name of the exported class, '
          + "e.g. 'Triager'.",
      })
    } else {
      const claimedBy = seenExports.get(exportName)
      if (claimedBy !== undefined) {
        problems.push({
          agent,
          message:
            `The export "${exportName}" is already registered as "${claimedBy}". One class is one `
            + 'agent: the runtime registry and the generated worker are both keyed on the export '
            + 'name, so a second claim on it makes one of the two registrations unreachable.',
        })
      } else {
        seenExports.set(exportName, agent)
      }
    }

    // Optional-chained rather than compared to `undefined`: `budget: null` is a
    // spelling a hand-written config produces, and reading a property through
    // it would throw where this is meant to report.
    const budget = registration?.budget
    if (budget?.callsPerMinute !== undefined) {
      const limit = budget.callsPerMinute
      // A finite positive integer or nothing. `Infinity` and `NaN` both defeat
      // the meter silently — the first admits every call, the second makes
      // every comparison false — and a fractional or negative limit has no
      // meaning a window can enforce. An unmetered agent is the one thing this
      // config may not express.
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
        problems.push({
          agent,
          message:
            `budget.callsPerMinute is ${String(limit)}. It must be a whole number of calls, at `
            + 'least 1: an unattended agent without a working meter is the failure the budget '
            + 'exists to prevent, and Infinity or NaN defeat it without erroring.',
        })
      }
    }

    const scopes = registration?.scopes
    if (!Array.isArray(scopes)) {
      problems.push({
        agent,
        message:
          'The registration has no `scopes` array. An agent that may call nothing is written as '
          + '`scopes: []`, never as an omitted key.',
      })
      continue
    }

    for (const scope of scopes) {
      if (typeof scope !== 'string') {
        problems.push({
          agent,
          message: `A scope entry is ${typeof scope}, not a string. Scopes are literal strings.`,
        })
        continue
      }
      const verdict = classifyRegistrationScope(scope)
      if (!verdict.allowed) {
        problems.push({ agent, scope, message: verdict.message })
      }
    }
  }

  return problems
}

/**
 * The problems as one message, for a caller that has to throw.
 *
 * Every line names the agent, because an app registers several and a message
 * that only named the scope would leave the reader grepping for it.
 */
export function describeAgentsConfigProblems(problems: readonly AgentsConfigProblem[]): string {
  return problems
    .map((problem) => `  - agents.${problem.agent}: ${problem.message}`)
    .join('\n')
}
