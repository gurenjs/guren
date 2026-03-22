import { Controller } from '@guren/core'
import { webPages } from '../../../resources/js/pages/contracts.js'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      message: 'Build full-stack web apps blazingly fast.',
    }

    return this.inertia(webPages.home, props, { url: this.request.path, title: 'Guren' })
  }
}
