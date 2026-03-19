import { Resource } from '@guren/server'
import type { UserRecord } from '../../Models/User.js'

export class UserResource extends Resource<UserRecord> {
  toArray() {
    return {
      id: this.resource.id,
      name: this.resource.name,
      email: this.resource.email,
      createdAt: this.resource.createdAt.toISOString(),
    }
  }
}
