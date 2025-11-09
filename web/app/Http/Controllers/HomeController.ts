import { Controller, Context } from '@guren/server'

export default class HomeController extends Controller {
  async index(ctx: Context): Promise<Response> {
    const props = {
      message: 'Build full-stack web apps blazingly fast.',
    }

    return this.inertia('Home', props, { url: ctx.req.path, title: 'Guren' })
  }
}
