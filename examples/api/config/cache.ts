import { defineCacheConfig } from '@guren/core'

export default defineCacheConfig(() => ({
  default: 'memory',
  stores: {
    memory: { driver: 'memory' },
  },
}))
