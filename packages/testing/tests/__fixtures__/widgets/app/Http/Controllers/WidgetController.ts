import { Controller } from '@guren/server'
import { listWidgets } from '../../Services/widgets.js'

export default class WidgetController extends Controller {
  index(): Response {
    return this.text(listWidgets().map((widget) => widget.title).join(','))
  }
}
