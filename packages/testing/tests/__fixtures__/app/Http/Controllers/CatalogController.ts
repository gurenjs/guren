import { Controller } from '@guren/server'
import { listWidgets } from '../../../widgets/index.js'

// A controller outside the module that reaches the module's public surface.
export default class CatalogController extends Controller {
  index(): Response {
    return this.text(listWidgets().map((widget) => widget.slug).join(','))
  }
}
