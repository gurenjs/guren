import { ServiceProvider, createStorageManager } from '@guren/core'

// Declared once, chosen per environment: set STORAGE_DISK in .env (or in
// your platform's vars) to switch without touching code. Drivers are built
// on first use, so a disk you never touch never opens a connection — but the
// values below are read when this object is built, so keep anything that can
// throw (a required-env helper) out of it.
const disks = {
  local: { driver: 'local', root: './storage/app' },
  // Declared public because it is: everything under it is served. A local
  // disk has no per-object visibility, so this is where that is decided.
  // Rooted inside public/ so the root asset server serves these files and
  // disk.url() returns a URL that actually resolves (images and the other
  // allowlisted extensions; add a route for anything else).
  public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
} as const

const selected = process.env.STORAGE_DISK ?? 'local'

export default class StorageProvider extends ServiceProvider {
  register(): void {
    // Checked here rather than left to the first upload: an unknown name is
    // accepted at construction and only throws when a disk is resolved,
    // which can be a queued job or a rarely-hit route in production.
    if (!(selected in disks)) {
      throw new Error(
        `STORAGE_DISK="${selected}" is not a declared disk. Declare it in app/Providers/StorageProvider.ts or use one of: ${Object.keys(disks).join(', ')}.`,
      )
    }

    this.container.instance('storage', createStorageManager({ default: selected, disks }))
  }
}
