import { ServiceProvider } from '@guren/core'
import { attachmentEngine } from '../../config/attachments'

export default class AttachmentsProvider extends ServiceProvider {
  // The import is half the wiring: config/attachments.ts calls
  // configureAttachments() at module scope, so loading it from a provider runs
  // that at boot, in web and worker processes alike. bindTo() is the other
  // half: without this app's container, the delivery route and storage both
  // resolve on whichever app configured attachments last in this process.
  register(): void {
    attachmentEngine.bindTo(this.container)
  }
}
