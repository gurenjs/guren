import type { DeployResult } from './deploy'
import type { DeployPlan } from './plan'

const ACTION_LABELS = {
  existing: 'existing',
  adopt: 'adopt (found by name; check it is this app\'s)',
  create: 'create on deploy',
  unknown: 'unknown',
} as const

/** The plan as text, the form a person reads before anything is written. */
export function formatPlan(plan: DeployPlan): string {
  const lines = [`Cloudflare deploy plan for ${plan.worker}:`]

  if (plan.bindings.length === 0) {
    lines.push('  No D1 or KV bindings.')
  }
  for (const binding of plan.bindings) {
    const id = binding.id ? ` ${binding.id}` : ''
    lines.push(`  ${binding.binding} (${binding.type}) "${binding.name}"${id}: ${ACTION_LABELS[binding.action]}`)
  }

  if (plan.migrations) {
    const { pending, layout, applyArgs } = plan.migrations
    lines.push(pending.length === 0
      ? `  Migrations: none pending (${layout} layout).`
      : `  Migrations: ${pending.length} pending (${layout} layout): ${pending.join(', ')}`)
    if (pending.length > 0) lines.push(`    Applied with: cf d1 migrations apply <DB id> ${applyArgs.map((arg) => (arg.includes('*') ? `'${arg}'` : arg)).join(' ')}`)
    for (const { migration, reason } of plan.migrations.acknowledged) {
      lines.push(`    ${migration}: destructive, acknowledged${reason ? ` (${reason})` : ''}`)
    }
  }
  if (plan.missingSecrets?.length === 0) lines.push('  Secrets: every required variable is provided.')

  for (const source of plan.unread) {
    lines.push(`  Not read: ${source}.`)
  }

  for (const finding of plan.findings) {
    const where = finding.binding ? ` ${finding.binding}` : ''
    lines.push(`${finding.severity === 'blocker' ? 'Blocker' : 'Warning'} [${finding.check}]${where}: ${finding.message}`)
    if (finding.fix) lines.push(`  Fix: ${finding.fix}`)
  }

  return lines.join('\n')
}

/** The whole run: the plan, then what was created, migrated and deployed, or where it stopped. */
export function formatResult(result: DeployResult): string {
  const lines = result.confirmed ? [] : [formatPlan(result.plan)]
  if (result.stopped === 'blocked') lines.push('Nothing was written: resolve the blockers above, then run again.')
  if (result.stopped === 'declined') lines.push('Nothing was written.')

  for (const resource of result.created) {
    lines.push(`Created ${resource.binding} (${resource.type}) "${resource.name}" ${resource.id}`)
  }
  if (result.migrated) {
    lines.push(`Applied ${result.migrated.applied.length} migration(s): ${result.migrated.applied.join(', ')}`)
    lines.push(`  Time Travel bookmark before them: ${result.migrated.bookmark}`)
  }
  if (result.deployment) {
    lines.push(result.deployment.output.trimEnd())
    lines.push(result.url ? `Deployed: ${result.url}` : 'Deployed. cf printed no workers.dev URL; see its output above.')
    lines.push(`Roll back with \`bunx cf workers deployments list --worker ${result.plan.worker}\` and a redeploy of an earlier version. A rollback does not revert migrations.`)
  }
  if (result.failure) {
    lines.push(`Failed at ${result.failure.stage}: ${result.failure.message}`)
    if (result.failure.cleanup.length > 0) {
      lines.push('Nothing was deleted. To undo what this run did:', ...result.failure.cleanup.map((command) => `  ${command}`))
    }
  }
  return lines.join('\n')
}
