import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      // Message text lives in lang/en/messages.json; `guren codegen` keeps
      // the key typed. Add lang/<locale>/ directories to translate the app.
      message: this.t('messages.welcome', { name: '__APP_TITLE__' }),
    }

    return this.inertia(pages.Home, props, { url: this.request.path, title: '__APP_TITLE__' })
  }
}
