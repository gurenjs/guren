import { ServiceProvider } from '@guren/core'
// The import is the wiring: config/attachments.ts calls configureAttachments()
// at module scope, and loading it from a provider guarantees that happens at
// boot — before the first attach(), in web and worker processes alike.
import '../../config/attachments'

export default class AttachmentsProvider extends ServiceProvider {
  register(): void {
    // Everything is wired by the config import above.
  }
}
