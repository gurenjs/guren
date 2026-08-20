import { z } from 'zod'

export const RegisterSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required.')
      .max(120, 'Name must be 120 characters or fewer.'),
    // Lowercased so it round-trips correctly through the password-reset and
    // email-verification token helpers, which normalize emails to lowercase
    // internally before matching against stored records.
    email: z
      .string()
      .trim()
      .min(1, 'Email is required.')
      .toLowerCase()
      .pipe(z.email('The email address is badly formatted.')),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters.'),
    passwordConfirmation: z
      .string()
      .min(1, 'Please confirm your password.'),
  })
  .refine((data) => data.password === data.passwordConfirmation, {
    message: 'Passwords do not match.',
    path: ['passwordConfirmation'],
  })

export type RegisterInput = z.infer<typeof RegisterSchema>
