import { Controller } from '@guren/core'
import { pageTitle } from '../../../config/site.js'
import { pages } from '@/.guren/pages.gen.js'

export default class WallpapersController extends Controller {
  async index(): Promise<Response> {
    return this.inertia(pages.Wallpapers, {}, { title: pageTitle('Wallpapers') })
  }
}
