import { Command } from '@guren/server'
import { resolveAttachmentEngine } from './engine.js'

/**
 * Console sweeper for the attachments layer (RFC 0013 §8): the polymorphic
 * `attachableType`/`attachableId` pair carries no foreign key, so deletion is
 * explicit (`purgeAttachments()`) plus this sweep. Register it in the console
 * kernel. Orphans are found by resolving `attachableType` through `Model.morphMap`;
 * a model missing there has its rows reported as unverifiable and left alone.
 */
export class AttachmentsPruneCommand extends Command {
  static override signature =
    'attachments:prune {--objects : Also delete attachments/ storage prefixes that no row references} {--dry-run : Report what would be removed without deleting}'

  static override description = 'Remove attachment rows whose owning record no longer exists'

  async handle(): Promise<void> {
    const engine = resolveAttachmentEngine('attachments:prune')
    const dryRun = this.hasOption('dry-run')
    const objects = this.hasOption('objects')
    const report = await engine.pruneOrphans({ objects, dryRun })

    const verb = dryRun ? 'would be removed' : 'removed'
    this.info(`Scanned ${report.scannedRows} attachment row(s).`)

    if (report.orphanRows.length === 0) {
      this.info('No orphaned rows.')
    } else {
      this.info(`${report.orphanRows.length} orphaned row(s) ${verb}:`)
      for (const row of report.orphanRows) {
        this.line(`  ${row.id} (${row.attachableType}#${row.attachableId})`)
      }
    }

    for (const skipped of report.skippedTypes) {
      this.warn(`Skipped '${skipped.type}': ${skipped.reason}`)
    }

    if (objects) {
      if (report.orphanObjectPrefixes.length === 0) {
        this.info('No orphaned storage prefixes.')
      } else {
        this.info(`${report.orphanObjectPrefixes.length} orphaned storage prefix(es) ${verb}:`)
        for (const orphan of report.orphanObjectPrefixes) {
          this.line(`  ${orphan.disk}: ${orphan.prefix}`)
        }
      }
      for (const skipped of report.skippedDisks) {
        this.warn(`Skipped disk '${skipped.disk}': ${skipped.reason}`)
      }
    }

    if (dryRun) {
      this.info('Dry run: nothing was deleted.')
    } else {
      this.success('Prune complete.')
    }
  }
}
