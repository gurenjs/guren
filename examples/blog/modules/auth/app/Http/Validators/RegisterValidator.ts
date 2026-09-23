import { z } from 'zod'

export const RegisterSchema = z
  .object({
    name: z
      .string({ error: 'Name is required.' })
      .trim()
      .min(1, 'Name is required.')
      .max(120, 'Name must be 120 characters or fewer.'),
    email: z
      .string({ error: 'Email is required.' })
      .trim()
      .min(1, 'Email is required.')
      // Lowercased to round-trip through the password-reset and
      // email-verification token helpers, which normalize before matching.
      .toLowerCase()
      .pipe(z.email('The email address is badly formatted.')),
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

export type RegisterInput = z.infer<typeof RegisterSchema>
