import type { AuthContext } from '@guren/server'
import type { UserRecord } from '../app/Models/User.js'

declare module '@guren/server' {
  interface InertiaSharedProps {
    auth: {
      user: Awaited<ReturnType<AuthContext['user']>> | UserRecord | null
    }
  }
}
