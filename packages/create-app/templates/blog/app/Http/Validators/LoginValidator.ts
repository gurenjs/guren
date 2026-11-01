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
  // Each branch ends in a boolean schema, so codegen types the parsed value as
  // a boolean (it cannot see what a trailing transform returns).
  remember: z
    .union([
      z.boolean(),
      z
        .string()
        .transform((value) => ['true', 'on', '1'].includes(value.toLowerCase()))
        .pipe(z.boolean()),
    ])
    .default(false),
})

export type LoginInput = z.infer<typeof LoginSchema>
