import type { AuthContext } from '@guren/core'
import type { UserRecord } from '../app/Models/User.js'

declare module '@guren/core' {
  interface InertiaSharedProps {
    auth: {
      user: Awaited<ReturnType<AuthContext['user']>> | UserRecord | null
    }
  }
}
