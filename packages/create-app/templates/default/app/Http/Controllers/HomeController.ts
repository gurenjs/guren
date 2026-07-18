import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      message: 'Welcome to __APP_TITLE__!',
    }

    return this.inertia(pages.Home, props, { url: this.request.path, title: '__APP_TITLE__' })
  }
}
