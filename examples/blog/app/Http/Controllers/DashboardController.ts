import { Controller } from '@guren/server'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()
    return this.inertia('dashboard/Index', { user }, { url: this.request.path, title: 'Dashboard | Guren Blog' })
  }
}
