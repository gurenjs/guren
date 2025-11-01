import { z } from 'zod'

export const LoginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.'),
  password: z
    .string({ required_error: 'Password is required.' })
    .min(1, 'Password is required.'),
  remember: z
    .union([
      z.boolean(),
      z
        .string()
        .transform((value: string) => ['true', 'on', '1'].includes(value.toLowerCase())),
    ])
    .optional()
    .transform((value): boolean => Boolean(value))
    .default(false),
})

export type LoginInput = z.infer<typeof LoginSchema>
