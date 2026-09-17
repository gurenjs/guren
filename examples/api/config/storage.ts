import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig(() => ({
  default: 'local',
  disks: {
    local: { driver: 'local', root: './storage/app' },
    public: { driver: 'local', root: './storage/app/public', visibility: 'public' },
  },
}))
