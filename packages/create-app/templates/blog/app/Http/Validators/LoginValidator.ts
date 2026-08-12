import { z } from 'zod'

export const LoginSchema = z.object({
  // Lowercased to match how registration stores emails — a case-sensitive
  // lookup would otherwise reject the same address typed with different casing.
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .toLowerCase()
    .pipe(z.email('The email address is badly formatted.')),
  password: z
    .string()
    .min(1, 'Password is required.'),
  remember: z
    .union([
      z.boolean(),
      z
        .string()
        .transform((value) => ['true', 'on', '1'].includes(value.toLowerCase())),
    ])
    .optional()
    .transform((value) => Boolean(value))
    .default(false),
})

export type LoginInput = z.infer<typeof LoginSchema>
