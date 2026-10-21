/**
 * The bindings the app itself names (RFC 0035 §2), read from the introspected app as
 * Workers runs it: an R2 disk registered through `r2Disk()`, and the D1 binding
 * `config/database.ts` names. Inference only adds; an opaque source is reported, never
 * read as absent.
 */
import type { DeployTargetApp } from '@guren/core/internal/deploy-check'

import { isRecord } from './backend'
import type { BindingInference } from './worker-manifest'

export interface InferredBindings {
  r2Buckets: string[]
  inference: BindingInference
}

export function inferBindings(app: DeployTargetApp | undefined): InferredBindings {
  if (!app) return { r2Buckets: [], inference: { unread: 'the build did not introspect the app' } }
  if (app.status === 'unread') return { r2Buckets: [], inference: { unread: app.reason } }

  const r2Buckets: string[] = []
  const opaqueDisks: string[] = []
  const entries = isRecord(app.storage) && isRecord(app.storage.entries) ? app.storage.entries : {}
  for (const [disk, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue
    if (entry.driver === null) opaqueDisks.push(disk)
    else if (entry.driver === 'r2' && typeof entry.binding === 'string' && !r2Buckets.includes(entry.binding)) r2Buckets.push(entry.binding)
  }
  const databaseBinding = isRecord(app.database) && app.database.dialect === 'd1' && typeof app.database.binding === 'string'
    ? app.database.binding
    : undefined

  return {
    r2Buckets: r2Buckets.sort(),
    inference: {
      ...(opaqueDisks.length > 0 ? { opaqueDisks: opaqueDisks.sort() } : {}),
      ...(databaseBinding ? { databaseBinding } : {}),
    },
  }
}
