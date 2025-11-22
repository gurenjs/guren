import { Controller } from '@guren/server'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      message: 'Welcome to __APP_TITLE__!',
    }

    return this.inertia('Home', props, { url: this.request.path, title: '__APP_TITLE__' })
  }
}
