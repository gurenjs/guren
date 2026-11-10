import { z } from 'zod'

export const ProfileUpdateSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(120, 'Name must be 120 characters or fewer.'),
  email: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .toLowerCase()
    .pipe(z.email('Enter a valid email address.')),
  // Defaults rather than transforms, so codegen types the parsed values as strings.
  password: z
    .string()
    .trim()
    .default('')
    .refine((value) => value === '' || value.length >= 8, 'Password must be at least 8 characters.'),
  // Untrimmed, as LoginSchema reads it: it is checked against the stored hash.
  currentPassword: z.string().default(''),
})

export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>
