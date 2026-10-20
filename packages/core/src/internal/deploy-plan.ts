/**
 * What a deploy plugin's plan needs from the ORM and the CLI (RFC 0035 §5, §6),
 * published as `@guren/core/internal/deploy-plan` so a plugin depends on core alone.
 * The destructive-migration judgement is the ORM's own (RFC 0034). The CLI is
 * reached lazily, as in `deploy-check`, and a CLI that cannot answer is reported
 * as such, never as "nothing required".
 */
import {
  ALLOW_DESTRUCTIVE_ENV,
  formatDestructiveFinding,
  judgeMigrations,
  readMigrationSources,
} from '@guren/orm/internal/migration-guard'

export { ALLOW_DESTRUCTIVE_ENV }

export interface PendingMigrationVerdict {
  /** `file:line: message (kind)` per statement no marker covers. */
  unacknowledged: string[]
  /** Migrations whose marker covers their findings, with its reason. */
  acknowledged: Array<{ migration: string; reason?: string }>
}

/**
 * Judges the pending migration folders under `migrationsFolder`, in the order they
 * would apply. Throws when a file cannot be read: a skipped file would pass exactly
 * the migration the guard could not judge.
 */
export function judgePendingMigrations(
  migrationsFolder: string,
  pending: readonly string[],
  displayFolder: string,
): PendingMigrationVerdict {
  const report = judgeMigrations(readMigrationSources(migrationsFolder, pending, displayFolder))
  return {
    unacknowledged: report.unacknowledged.map(formatDestructiveFinding),
    acknowledged: report.acknowledged.map(({ migration, reason }) => ({ migration, ...(reason ? { reason } : {}) })),
  }
}

export type DeployEnvRequirement =
  | { status: 'loaded'; required: readonly string[] }
  | { status: 'absent' }
  | { status: 'unreadable'; message: string }

interface DeployPlanCliApi {
  /** Absent on a @guren/cli older than RFC 0035. */
  requiredDeployEnv?(cwd: string): Promise<DeployEnvRequirement>
  assignedEnvKeys?(content: string): Set<string>
  loadScheduleKernel?(options: { appRoot: string }): Promise<{ kind: string; tasks?: unknown[]; path?: string; reasons?: string[] }>
}

/** Whether the app schedules tasks, read as `schedule:list` reads them; `unreadable` is never "none". */
export type ScheduledTasks =
  | { status: 'none' }
  | { status: 'loaded'; count: number }
  | { status: 'unreadable'; message: string }

export async function readScheduledTasks(root: string): Promise<ScheduledTasks> {
  const cli = await loadCli()
  if (typeof cli === 'string') return { status: 'unreadable', message: cli }
  if (typeof cli.loadScheduleKernel !== 'function') {
    return { status: 'unreadable', message: 'the installed @guren/cli predates loadScheduleKernel; upgrade it' }
  }
  try {
    const kernel = await cli.loadScheduleKernel({ appRoot: root })
    if (kernel.kind === 'missing') return { status: 'none' }
    if (kernel.kind === 'loaded') return { status: 'loaded', count: kernel.tasks?.length ?? 0 }
    return { status: 'unreadable', message: `${kernel.path ?? 'the schedule kernel'} could not be read (${kernel.kind}${kernel.reasons?.length ? `: ${kernel.reasons.join('; ')}` : ''})` }
  } catch (error) {
    return { status: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  }
}

let cliLoad: Promise<DeployPlanCliApi | string> | undefined

/** Loaded once per process: both readers below run in one plan. */
function loadCli(): Promise<DeployPlanCliApi | string> {
  cliLoad ??= import('@guren/cli').then(
    (cli) => cli as DeployPlanCliApi,
    (error: unknown) => `@guren/cli could not be loaded (${error instanceof Error ? error.message : String(error)})`,
  )
  return cliLoad
}

/** The `config/env.ts` keys a production deploy must set, as the app's own schema decides. */
export async function readRequiredDeployEnv(root: string): Promise<DeployEnvRequirement> {
  const cli = await loadCli()
  if (typeof cli === 'string') return { status: 'unreadable', message: cli }
  if (typeof cli.requiredDeployEnv !== 'function') {
    return { status: 'unreadable', message: 'the installed @guren/cli predates the deploy env check; upgrade it' }
  }
  try {
    return await cli.requiredDeployEnv(root)
  } catch (error) {
    return { status: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  }
}

/** The keys a dotenv file assigns a non-blank value to, read the way Bun reads it; the values are never kept. */
export async function readEnvFileKeys(content: string): Promise<Set<string> | string> {
  const cli = await loadCli()
  if (typeof cli === 'string') return cli
  if (typeof cli.assignedEnvKeys !== 'function') return 'the installed @guren/cli predates assignedEnvKeys; upgrade it'
  return cli.assignedEnvKeys(content)
}
