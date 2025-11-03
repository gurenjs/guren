import { z } from 'zod'

const requiredString = (field: string) =>
  z
    .string({ required_error: `${field} is required.` })
    .trim()
    .min(1, `${field} is required.`)

const optionalPasswordField = z
  .string()
  .optional()
  .transform((value) => value?.trim())

export const ProfileUpdateSchema = z
  .object({
    name: requiredString('Name'),
    email: z
      .string({ required_error: 'Email is required.' })
      .trim()
      .min(1, 'Email is required.')
      .email('Please provide a valid email address.'),
    password: optionalPasswordField,
    passwordConfirmation: optionalPasswordField,
  })
  .superRefine((data, ctx) => {
    const password = data.password ?? ''
    const confirmation = data.passwordConfirmation ?? ''

    if (password.length > 0 && password.length < 8) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Password must be at least 8 characters.',
      })
    }

    if (password.length > 0 && password !== confirmation) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['passwordConfirmation'],
        message: 'Passwords do not match.',
      })
    }
  })
  .transform(({ passwordConfirmation: _omit, password, ...rest }) => ({
    ...rest,
    password: password && password.length > 0 ? password : undefined,
  }))

export type ProfileUpdatePayload = z.infer<typeof ProfileUpdateSchema>
