import type { MessageSigner } from '../encryption/MessageSigner'

/**
 * The claims a password-reset or email-verification token carries.
 */
export interface SignedTokenClaims {
  /** The opaque id the backing store keys the token by. */
  id: string
  /** The email the token was issued for, lower-cased at issuance. */
  email: string
}

/**
 * Read the claims of a signed one-time token, deciding expiry from the
 * token alone.
 *
 * The `exp` claim signed into the token is the one authority on expiry. The
 * store's `expiresAt` is written from the same `expiresIn` at issuance and
 * exists for the store's own housekeeping (TTLs, cleanup sweeps); a store that
 * still returns an expired record is not trusted over the signature, and a
 * store that already dropped it is simply a missing record. That is what lets
 * the verify path take no configuration: nothing decided at issuance can be
 * re-decided later, and the signing key comes from `APP_KEY`, not from the
 * config object `create*Token` accepts.
 *
 * An expired token is signature-checked before it is rejected, so `deleteExpired`
 * only ever runs for an id this app issued.
 */
export async function readSignedTokenClaims(
  signer: MessageSigner,
  token: string,
  purpose: string,
  deleteExpired: (id: string) => Promise<void>,
): Promise<SignedTokenClaims | null> {
  const payload = signer.verify<{ id?: string; email?: string }>(token, {
    purpose,
    allowExpired: true,
  })
  if (!payload?.id || !payload.email) {
    return null
  }

  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    await deleteExpired(payload.id)
    return null
  }

  return { id: payload.id, email: payload.email }
}
