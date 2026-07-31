import { ServiceProvider, getGate } from '@guren/core'
import { Post } from '../Models/Post.js'
import { PostPolicy } from '../Policies/PostPolicy.js'

/**
 * Maps models to their policies. `PostController` calls `this.authorize()` in
 * every mutating action, and without a registered policy the gate has nothing
 * to consult and denies them all.
 *
 * The framework's own provider creates the gate during registration, so this
 * runs in boot() — getGate() throws before that.
 */
export default class AuthorizationProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    getGate().policy(Post, PostPolicy)
  }
}
