import { z } from 'zod'

const requiredString = (field: string) =>
  z
    .string({ required_error: `${field} is required.` })
    .trim()
    .min(1, `${field} is required.`)

const baseFields = {
  title: requiredString('Title'),
  excerpt: requiredString('Excerpt'),
  body: requiredString('Body'),
}

export const PostPayloadSchema = z.object(baseFields)

export type PostPayload = z.infer<typeof PostPayloadSchema>

const bodyField = baseFields.body

export const PostFormSchema = z.object({
  id: z.number().int().optional(),
  title: baseFields.title,
  excerpt: baseFields.excerpt,
  body: z.union([bodyField, z.null(), z.undefined()]).transform((value) => value ?? ''),
})

export type PostFormData = z.infer<typeof PostFormSchema>

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})
