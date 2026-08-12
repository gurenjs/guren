import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      // Message text lives in lang/en/messages.json (key typed by codegen).
      message: this.t('messages.welcome', { name: '__APP_TITLE__' }),
    }

    return this.inertia(pages.Home, props, { title: '__APP_TITLE__' })
  }
}
