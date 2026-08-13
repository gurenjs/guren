// Generated from app/Http/Resources (and modules/*/app/Http/Resources) — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { TaskRecord } from '../app/Models/Task.js'
import type { UserRecord } from '../app/Models/User.js'
import type { WithRelations } from '@guren/orm'

/**
 * Auto-extracted data types from Resource classes.
 * Import these in your frontend to get typed API responses.
 */
export namespace Data {
  export type Task = {
  id: number
  title: string
  description: string | null
  completed: boolean
  notificationArtifactPath: string
  broadcastChannels: {
    public: string
    private: string
  }
  createdAt: string
  updatedAt: string
  owner?: { id: number | undefined; name: string | undefined }
}

  export type User = {
  id: number
  name: string
  email: string
  createdAt: string
}
}
