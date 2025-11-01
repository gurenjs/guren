import type { Context } from '@guren/core'
import Controller from './Controller'

export default class DashboardController extends Controller {
  async index(ctx: Context): Promise<Response> {
    const user = await this.auth.user()
    return this.inertiaWithAuth('dashboard/Index', { user }, { url: ctx.req.path, title: 'Dashboard | Guren Blog' })
  }
}
