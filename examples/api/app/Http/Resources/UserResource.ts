import { Resource } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'

export interface UserResourceData extends Record<string, unknown> {
  id: number
  name: string
  email: string
  createdAt: string
}

export class UserResource extends Resource<UserRecord> {
  toArray(): UserResourceData {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
      createdAt: this.resource.createdAt.toISOString(),
    }
  }
}
