import { Model, configureAttachments, getContainer } from '@guren/core'
import { attachments } from '../db/schema'
import { Post } from '../app/Models/Post.js'

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
  // Uploads are bytes a stranger chose, so they are stored on a disk that
  // nothing serves statically — `local` is rooted at ./storage/app, outside
  // public/ — and handed out through the signed delivery route that
  // registerAttachmentRoutes(router) mounts in routes/web.ts. That route
  // serves only an allowlist of types inline, forces a download for the rest,
  // and adds nosniff plus a sandbox CSP. Rooting this disk inside public/
  // instead would bypass all of it; `guren check` fails that shape, and
  // StorageProvider.ts says why at the disk in question.
  disk: 'local',
  // Per-disk visibility. 'public' disks build URLs with disk.url(); 'private'
  // ones go through the delivery route below. Undeclared disks count as
  // public, so a private disk has to say so.
  disks: { local: 'private', public: 'public' },
  // Presence is the switch: private-disk URLs become signed delivery-route
  // URLs instead of disk.temporaryUrl(). Accepts `prefix` and `routeName`.
  delivery: {},
})

// attachments:prune resolves each row's attachableType through this map to
// verify the owning record still exists — register every model that declares
// attachments.
Model.morphMap = { Post }
