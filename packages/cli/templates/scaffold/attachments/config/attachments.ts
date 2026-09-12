import { configureAttachments } from '@guren/core'
import { attachments } from '../db/schema'

// Wires the attachments layer once at boot. `Attachment` is the app-local model
// over the attachments table — use it for morph relations and advanced queries;
// the typed day-to-day API lives on your models via the Attachable mixin.
// `attachmentEngine` is what AttachmentsProvider binds on the app's container.

// See the attachments guide for declarations, image validation, variants, and
// queued generation.
export const { Attachment, engine: attachmentEngine } = configureAttachments({
  table: attachments,
  storage: (container) => container.make('storage'),
  // Uploads are bytes a stranger chose, so they are stored on a disk that
  // nothing serves statically — `local` is rooted at ./storage/app, outside
  // public/ — and handed out through the signed delivery route that
  // registerAttachmentRoutes(router) mounts.

  // That route serves only an allowlist of types inline, forces a download for
  // the rest, and adds nosniff plus a sandbox CSP.

  // Rooting this disk inside public/ instead would bypass all of it: `guren
  // check` fails that shape, and StorageProvider.ts says why at the disk in
  // question.
  disk: 'local',
  // Per-disk visibility. 'public' disks build URLs with disk.url(); 'private'
  // ones go through the delivery route below. Undeclared disks count as
  // public, so a private disk has to say so.
  disks: { local: 'private', public: 'public' },
  // Presence is the switch: private-disk URLs become signed delivery-route
  // URLs instead of disk.temporaryUrl(). Accepts `prefix` and `routeName`.
  delivery: {},
})
