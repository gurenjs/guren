import { z } from 'zod'

export const ForgotPasswordSchema = z.object({
  email: z
    .string({ error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    .email('The email address is badly formatted.'),
})

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>
