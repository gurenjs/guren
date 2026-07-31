import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(255, 'Title must be 255 characters or fewer.'),
  excerpt: z.string().trim().min(1, 'Excerpt is required.').max(500, 'Excerpt must be 500 characters or fewer.'),
  body: z.string().trim().min(1, 'Body is required.'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>
