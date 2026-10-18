import { consola } from 'consola'
import { ALLOW_DESTRUCTIVE_ENV, ALLOW_DESTRUCTIVE_MARKER, formatDestructiveFinding } from '@guren/orm/internal/migration-guard'
import { markCommandFailed } from '../command-status'
import { defineCommand } from '../define-command'
import { runDatabaseMigrations, runDatabaseSeeders, resetDatabase } from '../db-migrate'
import type { MigrationRunSummary, SeederRunSummary } from '../db-migrate'
import { showMigrationStatus } from '../db-status'
import { judgePendingMigrations, type PendingMigrationJudgement } from '../db-migration-guard'
import { describeMigrationsFolder, describeSeedersFolder } from './display-paths'
import { assertDestructiveCommandAllowed } from './destructive-guard'

function reportDryRun(action: string, message: string, json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ dryRun: true, action, message, ...extra }, null, 2))
  } else {
    consola.info(`[dry-run] ${message}`)
  }
}

function reportSuccess(action: string, message: string, json: boolean, extra?: Record<string, unknown>): void {
  if (json) {
    console.log(JSON.stringify({ success: true, action, message, ...extra }, null, 2))
  } else {
    consola.success(message)
  }
}

/** The two fields every db command reports about a migration run, or nothing when it has no summary. */
function migrationRunFields(summary: MigrationRunSummary | undefined): Record<string, unknown> | undefined {
  return summary && { migrationsFound: summary.migrationsFound, looseSqlFiles: summary.looseSqlFiles }
}

/**
 * Reports a migration run that applied nothing — `db:migrate`, `db:reset` and
 * `db:fresh` can all end on one, where a ✔ would read as an up-to-date database
 * (after a reset, as one that still has its tables).
 */
function reportNoMigrationsApplied(
  action: string,
  summary: MigrationRunSummary,
  outcome: string,
  json: boolean,
  extra?: Record<string, unknown>,
): void {
  const message = `No migrations found in ${describeMigrationsFolder(summary.migrationsFolder)} — ${outcome}.`

  if (json) {
    reportSuccess(action, message, true, { ...migrationRunFields(summary), ...extra })
    return
  }

  consola.warn(message)
  // A folder holding loose .sql files is not one waiting for db:make — the ORM
  // has already explained why they were skipped.
  if (summary.looseSqlFiles === 0) {
    consola.info(`Generate one with \`bun run db:make\`, then re-run \`bun run ${action}\`.`)
  }
}

/** The two fields every db command reports about a seed run, or nothing when it has no summary. */
function seederRunFields(summary: SeederRunSummary | undefined): Record<string, unknown> | undefined {
  return summary && { seedersRan: summary.seedersRan, filesWithoutSeeder: summary.filesWithoutSeeder }
}

/**
 * Reports a seed run that ran nothing. `db/seeders/` is scaffolded empty, so a ✔
 * would describe a database holding none of the rows the seeders would write.
 */
function reportNoSeedersRan(
  action: string,
  summary: SeederRunSummary,
  outcome: string,
  json: boolean,
  extra?: Record<string, unknown>,
): void {
  const message = `No seeders found in ${describeSeedersFolder(summary.seedersFolder)} — ${outcome}.`

  if (json) {
    reportSuccess(action, message, true, { ...seederRunFields(summary), ...extra })
    return
  }

  consola.warn(message)
  // Files that exported no seeder are not a folder waiting for make:seeder —
  // the seeders are written, just in a shape the loader skips.
  if (summary.filesWithoutSeeder === 0) {
    // Always db:seed, never the command that reported this: the migrations are
    // applied by now, so db:reset would drop every table again.
    consola.info('Generate one with `bunx guren make:seeder`, then run `bun run db:seed`.')
  } else {
    consola.info(
      `${summary.filesWithoutSeeder} file(s) there exported no seeder — each must default-export a handler, or export \`seed\`, \`run\`, or \`Seeder\`.`,
    )
  }
}

/**
 * `db:reset` and `db:fresh` are the same command under two names, sharing one
 * body so the guard against reporting success for a reset that dropped every
 * table and re-applied nothing cannot come to hold for only one.
 */
async function runResetCommand(
  action: 'db:reset' | 'db:fresh',
  doneVerb: 'reset' | 'refreshed',
  args: { seed?: boolean; force?: boolean; json?: boolean; 'dry-run'?: boolean },
): Promise<void> {
  assertDestructiveCommandAllowed(args.force)

  const seed = Boolean(args.seed)
  const json = Boolean(args.json)

  if (args['dry-run']) {
    const message = seed
      ? 'Would drop all tables, re-run all migrations, and run seeders.'
      : 'Would drop all tables and re-run all migrations.'
    reportDryRun(action, message, json, { seed })
    return
  }

  if (!json) consola.info('Dropping all tables...')
  const { migrations, seeders } = await resetDatabase({ seed })
  // Assembled once so every exit below reports the same run the same way.
  const runFields = { ...migrationRunFields(migrations), ...seederRunFields(seeders), seed }

  // The migration half wins when both came back empty: seeding an empty schema
  // could not have worked anyway, and stacking both warnings would bury it.
  if (migrations?.migrationsFound === 0) {
    reportNoMigrationsApplied(action, migrations, 'the tables were dropped and nothing was re-applied', json, runFields)
    return
  }

  if (seeders?.seedersRan === 0) {
    reportNoSeedersRan(action, seeders, `the database was ${doneVerb} but nothing was seeded`, json, runFields)
    return
  }

  const message = seed
    ? `Database ${doneVerb} and seeded successfully.`
    : `Database ${doneVerb} successfully.`
  reportSuccess(action, message, json, runFields)
}

function destructiveFields(judgement: PendingMigrationJudgement): Record<string, unknown> {
  return {
    destructive: {
      pending: judgement.pending,
      pendingFrom: judgement.pendingFrom,
      findings: judgement.unacknowledged,
      acknowledged: judgement.acknowledged,
    },
  }
}

/** Prints what the guard found; the caller decides whether it refuses. */
function reportDestructiveFindings(judgement: PendingMigrationJudgement, allowed: boolean): void {
  for (const { file, reason } of judgement.acknowledged) {
    consola.info(`${file} acknowledges its destructive statements: ${reason ?? '(no reason given after the marker)'}`)
  }
  if (judgement.unacknowledged.length === 0) return

  const log = allowed ? consola.warn : consola.error
  log(`${judgement.unacknowledged.length} destructive statement(s) in pending migrations carry no acknowledgement:`)
  for (const finding of judgement.unacknowledged) {
    consola.log(`  ${formatDestructiveFinding(finding)}`)
  }
  if (judgement.pendingFrom === 'all') {
    consola.info(
      'config/database.ts exports no migrationStatus(), so every local migration was judged, applied ones included. ' +
        'Export it (the database factory returns one) to judge only the pending ones.',
    )
  }
  if (!allowed) {
    consola.info(
      `Review each one. To apply it, put \`-- ${ALLOW_DESTRUCTIVE_MARKER}: <reason>\` on the first line of its migration.sql, ` +
        'or re-run with --allow-destructive. An agent asks the user before doing either.',
    )
  }
}

export const migrateCommand = defineCommand({
  meta: {
    name: 'db:migrate',
    description: 'Run all pending database migrations, refusing destructive ones no migration acknowledges.',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Check the pending migrations for destructive statements without applying them',
    },
    'allow-destructive': {
      type: 'boolean',
      description: 'Apply destructive statements that carry no -- guren:allow-destructive comment',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const json = Boolean(args.json)
    const allowed = Boolean(args['allow-destructive'])
    const judgement = await judgePendingMigrations()
    const refused = judgement.unacknowledged.length > 0 && !allowed

    if (!json) reportDestructiveFindings(judgement, allowed)

    if (args['dry-run']) {
      const message = refused
        ? `${judgement.pending.length} pending migration(s); ${judgement.unacknowledged.length} destructive statement(s) would be refused.`
        : `Would apply ${judgement.pending.length} pending migration(s).`
      reportDryRun('db:migrate', message, json, destructiveFields(judgement))
      if (refused) markCommandFailed()
      return
    }

    if (refused) {
      if (json) {
        console.log(JSON.stringify({
          success: false,
          action: 'db:migrate',
          message: 'Refused: pending migrations contain destructive statements no migration acknowledges.',
          ...destructiveFields(judgement),
        }, null, 2))
      }
      markCommandFailed()
      return
    }

    // The factory's own boot-path guard runs inside migrateDatabase() and reads this.
    if (allowed) process.env[ALLOW_DESTRUCTIVE_ENV] = '1'
    const summary = await runDatabaseMigrations()

    if (summary?.migrationsFound === 0) {
      reportNoMigrationsApplied('db:migrate', summary, 'nothing was applied', json, destructiveFields(judgement))
      return
    }

    reportSuccess('db:migrate', 'Database migrations completed.', json, { ...migrationRunFields(summary), ...destructiveFields(judgement) })
  },
})

export const seedCommand = defineCommand({
  meta: {
    name: 'db:seed',
    description: 'Execute database seeders.',
  },
  args: {
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    assertDestructiveCommandAllowed(args.force)

    if (args['dry-run']) {
      reportDryRun('db:seed', 'Would execute database seeders.', Boolean(args.json))
      return
    }

    const summary = await runDatabaseSeeders()

    if (summary?.seedersRan === 0) {
      reportNoSeedersRan('db:seed', summary, 'nothing was seeded', Boolean(args.json))
      return
    }

    reportSuccess('db:seed', 'Database seeders executed.', Boolean(args.json), seederRunFields(summary))
  },
})

export const resetCommand = defineCommand({
  meta: {
    name: 'db:reset',
    description: 'Drop all tables, re-run migrations, and optionally re-seed.',
  },
  args: {
    seed: {
      type: 'boolean',
      description: 'Run seeders after migrations',
      alias: 's',
    },
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    await runResetCommand('db:reset', 'reset', args)
  },
})

export const freshCommand = defineCommand({
  meta: {
    name: 'db:fresh',
    description: 'Drop all tables and re-run all migrations (alias for db:reset).',
  },
  args: {
    seed: {
      type: 'boolean',
      description: 'Run seeders after migrations',
      alias: 's',
    },
    force: {
      type: 'boolean',
      description: 'Run in production without confirmation',
      alias: 'f',
    },
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
    'dry-run': {
      type: 'boolean',
      alias: 'd',
      description: 'Show what would happen without executing',
    },
  },
  async run({ args }) {
    await runResetCommand('db:fresh', 'refreshed', args)
  },
})

export const rollbackCommand = defineCommand({
  meta: {
    name: 'db:rollback',
    description: 'Explain how to undo migrations (Guren uses forward-only drizzle-kit migrations).',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output result as JSON',
    },
  },
  async run({ args }) {
    const message =
      'Guren migrations are generated by drizzle-kit and are forward-only — there are no down migrations to roll back.'
    const remedies = [
      'Development: `guren db:reset --seed` drops everything and re-applies all migrations from scratch.',
      'Undo an uncommitted migration: delete its folder under db/migrations/, then `guren db:reset`.',
      'Production: write a new forward migration that reverses the change (edit db/schema.ts, then `bun run db:make`).',
    ]

    if (args.json) {
      console.log(JSON.stringify({ command: 'db:rollback', status: 'unsupported', message, remedies }, null, 2))
    } else {
      consola.error(message)
      consola.info('Instead:')
      for (const remedy of remedies) {
        consola.info(`  • ${remedy}`)
      }
    }
    markCommandFailed()
  },
})

export const statusCommand = defineCommand({
  meta: {
    name: 'db:status',
    description: 'Show the status of all migrations.',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
  },
  async run({ args }) {
    await showMigrationStatus({ json: Boolean(args.json) })
  },
})
