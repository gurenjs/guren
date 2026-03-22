import { Controller } from '@guren/core'
import { appPages } from '../../../resources/js/pages/contracts.js'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      message: 'Welcome to __APP_TITLE__!',
    }

    return this.inertia(appPages.home, props, { url: this.request.path, title: '__APP_TITLE__' })
  }
}
