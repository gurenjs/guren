// Generated from app/Http/Resources — DO NOT EDIT
// Run `guren codegen` to regenerate.

import type { PostRecord, PostAuthorSummary } from '../app/Models/Post.js'
import type { WithRelations } from '@guren/core'

/**
 * Auto-extracted data types from Resource classes.
 * Import these in your frontend to get typed API responses.
 */
export namespace Data {
  export type Post = {
  id: number
  title: string
  excerpt: string
  body: string
  authorId: number
  // Serialized here because `created_at` is a string on SQLite and a Date on
  // PostgreSQL and MySQL — pages should not have to know which.
  createdAt: string
  author?: PostAuthorSummary
}
}
