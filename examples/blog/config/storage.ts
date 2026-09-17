import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig(() => ({
  default: 'local',
  disks: {
    local: { driver: 'local', root: './storage/app' },
    // Rooted inside public/ so the asset server serves these files and
    // disk.url() resolves. For assets this app writes itself only: anything
    // here is fetchable with no signature, expiry or authorization check.
    // Uploaded bytes go on `local` above, behind the signed delivery route.
    public: { driver: 'local', root: './public/storage', url: '/storage', visibility: 'public' },
  },
}))
