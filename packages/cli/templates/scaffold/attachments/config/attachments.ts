import { configureAttachments, getContainer } from '@guren/core'
import { attachments } from '@/db/schema'

/**
 * Wires the attachments layer once at boot (AttachmentsProvider imports this
 * module). `Attachment` is the app-local model over the attachments table —
 * use it for morph relations and advanced queries; the typed day-to-day API
 * lives on your models via the Attachable mixin.
 *
 * See the attachments guide for declarations, image validation, variants,
 * and queued generation.
 */
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => getContainer().make('storage'),
  // Where new attachments are stored, and how their URLs are built: 'public'
  // disks serve via disk.url(), 'private' ones via disk.temporaryUrl().
  disk: 'public',
  disks: { public: 'public' },
})
