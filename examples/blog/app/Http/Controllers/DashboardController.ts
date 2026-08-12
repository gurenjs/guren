import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user<{ id: number; name: string; email: string }>()
    return this.inertia(pages.dashboard.Index, { user }, { title: 'Dashboard | Guren Blog' })
  }
}
