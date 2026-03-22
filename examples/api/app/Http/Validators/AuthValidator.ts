import { z } from 'zod'

export const RegisterSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  email: z.string().email('Invalid email format'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
})

export const LoginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
})

export const CreateTokenSchema = z.object({
  name: z.string().min(1, 'Token name is required').max(255),
  abilities: z.array(z.string()).optional().default(['*']),
  expiresInDays: z.number().int().positive().optional(),
})

export const TokenIdParamSchema = z.object({
  id: z.string().min(1),
})

export type RegisterInput = z.infer<typeof RegisterSchema>
export type LoginInput = z.infer<typeof LoginSchema>
export type CreateTokenInput = z.infer<typeof CreateTokenSchema>
