import { Controller } from '@guren/server'

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const props = {
      message: 'Build full-stack web apps blazingly fast.',
    }

    return this.inertia('Home', props, { url: this.request.path, title: 'Guren' })
  }
}
