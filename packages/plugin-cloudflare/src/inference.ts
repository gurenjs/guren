/**
 * The bindings the app itself names (RFC 0035 §2), read from the introspected app as
 * Workers runs it: an R2 disk registered through `r2Disk()`, and the D1 binding
 * `config/database.ts` names. Inference only adds; an opaque source is reported, never
 * read as absent.
 */
import type { DeployTargetApp } from '@guren/core/internal/deploy-check'

import { isRecord } from './backend'

export interface BindingInference {
  /** R2 bucket bindings the disks name; `gurenWorker()` binds them from the manifest. */
  r2Buckets: string[]
  /** Why the app could not be introspected; nothing was inferred. */
  unread?: string
  /** Disks registered with a bare factory, which may be R2 without saying so. */
  opaqueDisks?: string[]
  /** The D1 binding `config/database.ts` names, when it names one as a string. */
  databaseBinding?: string
}

export function inferBindings(app: DeployTargetApp | undefined): BindingInference {
  if (!app) return { r2Buckets: [], unread: 'the build did not introspect the app' }
  if (app.status === 'unread') return { r2Buckets: [], unread: app.reason }

  const r2Buckets: string[] = []
  const opaqueDisks: string[] = []
  const entries = isRecord(app.storage) && isRecord(app.storage.entries) ? app.storage.entries : {}
  for (const [disk, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue
    if (entry.driver === 'r2' && typeof entry.binding === 'string') {
      if (!r2Buckets.includes(entry.binding)) r2Buckets.push(entry.binding)
    } else if (entry.driver === null || entry.driver === 'r2') {
      // A bare factory, or r2Disk() given a closure: R2 or not, its bucket cannot be seen.
      opaqueDisks.push(disk)
    }
  }
  const databaseBinding = isRecord(app.database) && app.database.dialect === 'd1' && typeof app.database.binding === 'string'
    ? app.database.binding
    : undefined

  return {
    r2Buckets: r2Buckets.sort(),
    ...(opaqueDisks.length > 0 ? { opaqueDisks: opaqueDisks.sort() } : {}),
    ...(databaseBinding ? { databaseBinding } : {}),
  }
}
