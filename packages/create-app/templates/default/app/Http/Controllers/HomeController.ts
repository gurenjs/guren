import { Controller, Context } from '@guren/server'

export default class HomeController extends Controller {
  async index(ctx: Context): Promise<Response> {
    const props = {
      message: 'Welcome to __APP_TITLE__!',
    }

    return this.inertia('Home', props, { url: ctx.req.path, title: '__APP_TITLE__' })
  }
}
