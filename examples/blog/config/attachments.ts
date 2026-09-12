import { Model, configureAttachments } from '@guren/core'
import { attachments } from '../db/schema'
import { Post } from '../app/Models/Post.js'

/**
 * Wires the attachments layer once at boot. `Attachment` is the app-local model
 * over the table, for morph relations and advanced queries; the day-to-day API
 * lives on models via the Attachable mixin. `attachmentEngine` is what
 * AttachmentsProvider binds on the app's container.
 */
export const { Attachment, engine: attachmentEngine } = configureAttachments({
  table: attachments,
  storage: (container) => container.make('storage'),
  // Uploads are bytes a stranger chose, so `local` is rooted outside public/
  // and served only through the signed delivery route registerAttachmentRoutes()
  // mounts, which inlines an allowlist of types, forces a download for the rest,
  // and adds nosniff plus a sandbox CSP. Rooting it inside public/ bypasses all
  // of that, and `guren check` fails that shape.
  disk: 'local',
  // 'public' disks build URLs with disk.url(); 'private' ones go through the
  // delivery route below. Undeclared counts as public, so a private disk must say so.
  disks: { local: 'private', public: 'public' },
  // Presence is the switch: private-disk URLs become signed delivery-route
  // URLs instead of disk.temporaryUrl(). Accepts `prefix` and `routeName`.
  delivery: {},
})

// attachments:prune resolves attachableType through this map to check the owning
// record still exists, so every model declaring attachments belongs here.
Model.morphMap = { Post }
