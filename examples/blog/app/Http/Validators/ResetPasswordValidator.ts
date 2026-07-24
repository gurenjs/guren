import { z } from 'zod'

export const ResetPasswordSchema = z
  .object({
    token: z.string({ error: 'Reset token is required.' }).min(1, 'Reset token is required.'),
    password: z
      .string({ error: 'Password is required.' })
      .min(8, 'Password must be at least 8 characters.'),
    passwordConfirmation: z
      .string({ error: 'Please confirm your password.' })
      .min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
