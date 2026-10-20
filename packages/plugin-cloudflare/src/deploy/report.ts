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
