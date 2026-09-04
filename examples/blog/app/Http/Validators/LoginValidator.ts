import { z } from 'zod'

export const LoginSchema = z.object({
  email: z
    .string({ error: 'Email is required.' })
    .trim()
    .min(1, 'Email is required.')
    // Registration stores emails lowercased, so a case-sensitive lookup would
    // answer "Invalid credentials" to someone who registered as Ada@Example.com.
    .toLowerCase()
    .pipe(z.email('The email address is badly formatted.')),
  password: z
    .string({ error: 'Password is required.' })
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
