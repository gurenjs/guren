import { z } from 'zod'

export const ForgotPasswordSchema = z.object({
  // Lowercased to match how registration stores emails and how the
  // password-reset token helpers normalize emails internally.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .toLowerCase()
    .pipe(z.email('The email address is badly formatted.')),
})

export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>
