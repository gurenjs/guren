import { z } from 'zod'

/**
 * The console signs in with the plaintext operator token `bun run db:seed`
 * printed, not a password: `users` carries no password column, and hashing one
 * per login would spend the Workers Free plan's 10 ms CPU budget on a demo
 * that has a cheap SHA-256 credential already.
 */
export const OperatorLoginSchema = z.object({
  token: z.string().min(1),
})
