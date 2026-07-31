import { Policy, type AuthUser } from '@guren/core'

interface PostLike {
  authorId: number
}

/**
 * Bound to the Post model in app/Providers/AuthorizationProvider.ts.
 * PostController calls `this.authorize()` for every mutating action, so a
 * signed-in user can only edit or delete their own posts.
 */
export class PostPolicy extends Policy {
  viewAny(_user: AuthUser | null): boolean {
    return true
  }

  view(_user: AuthUser | null, _post: PostLike): boolean {
    return true
  }

  create(user: AuthUser | null): boolean {
    return user !== null
  }

  update(user: AuthUser | null, post: PostLike): boolean {
    return user !== null && Number(user.id) === post.authorId
  }

  delete(user: AuthUser | null, post: PostLike): boolean {
    return user !== null && Number(user.id) === post.authorId
  }
}
