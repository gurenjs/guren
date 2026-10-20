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
