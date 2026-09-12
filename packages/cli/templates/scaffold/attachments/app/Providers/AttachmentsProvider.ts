import { ServiceProvider } from '@guren/core'
// Loading this module is what runs configureAttachments(), at boot, in web and
// worker processes alike.
import { attachmentEngine } from '../../config/attachments'

export default class AttachmentsProvider extends ServiceProvider {
  // Without this app's container, the delivery route and the storage factory
  // both resolve on whichever app configured attachments last in the process.
  register(): void {
    attachmentEngine.bindTo(this.container)
  }
}
