import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const currentUser = await this.auth.user<UserRecord | null>()
    const user = currentUser
      ? {
          id: currentUser.id,
          name: currentUser.name,
          email: currentUser.email,
        }
      : null
    return this.inertia(pages.dashboard.Index, { user }, { url: this.request.path, title: 'Dashboard' })
  }
}
