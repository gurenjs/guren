import { ServiceProvider } from '@guren/core'
import { Post } from '../Models/Post.js'
import { PostPolicy } from '../Policies/PostPolicy.js'

/**
 * Maps models to their policies. `PostController` calls `this.authorize()` in
 * every mutating action, and without a registered policy the gate has nothing
 * to consult and denies them all.
 */
export default class AuthorizationProvider extends ServiceProvider {
  register(): void {}

  // The framework's own provider binds the gate during registration, so this
  // runs in boot() — make('gate') throws before that.
  boot(): void {
    this.container.make('gate').policy(Post, PostPolicy)
  }
}
