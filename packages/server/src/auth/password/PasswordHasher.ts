export interface PasswordHasher {
  hash(plain: string): Promise<string>
  verify(hashed: string, plain: string): Promise<boolean>
  needsRehash?(hashed: string): boolean
}
