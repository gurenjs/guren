import { Command } from '@guren/server'
import { resolveAttachmentEngine } from './engine.js'

/**
 * Console sweeper for the attachments layer (RFC 0013 §8). The polymorphic
 * `attachableType`/`attachableId` pair cannot carry a foreign key, so no
 * database cascade exists; deletion is explicit (`purgeAttachments()` in
 * destroy actions) plus this sweep for whatever slipped past it — records
 * deleted through paths that never purged, and, with `--objects`, storage
 * prefixes left behind by crashed or raced jobs.
 *
 * Register it in the app's console kernel:
 *
 * ```ts
 * // src/console.ts
 * import { AttachmentsPruneCommand } from '@guren/core'
 * kernel.register(AttachmentsPruneCommand)
 * ```
 *
 * Orphan rows are detected by resolving each `attachableType` through
 * `Model.morphMap` and querying for the records — set
 * `Model.morphMap = { Post, User, ... }` for every model that declares
 * attachments, or their rows are reported as unverifiable and left alone.
 */
export class AttachmentsPruneCommand extends Command {
  static override signature =
    'attachments:prune {--objects : Also delete attachments/ storage prefixes that no row references} {--dry-run : Report what would be removed without deleting}'

  static override description = 'Remove attachment rows whose owning record no longer exists'

  async handle(): Promise<void> {
    const engine = resolveAttachmentEngine('attachments:prune')
    const dryRun = this.hasOption('dry-run')
    const report = await engine.pruneOrphans({ objects: this.hasOption('objects'), dryRun })

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

    if (this.hasOption('objects')) {
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
