import type { MessageSigner } from '../encryption/MessageSigner'

/** The claims a password-reset or email-verification token carries. */
export interface SignedTokenClaims {
  /** The opaque id the backing store keys the token by. */
  id: string
  /** The email the token was issued for, lower-cased at issuance. */
  email: string
}

/**
 * Read the claims of a signed one-time token, deciding expiry from the `exp`
 * claim signed into it rather than from the store's copy.
 *
 * The signature is checked before anything is deleted, so the housekeeping
 * `store.delete` only ever runs for an id this app issued.
 */
export async function readSignedTokenClaims(
  signer: MessageSigner,
  token: string,
  purpose: string,
  store: { delete(tokenId: string): Promise<void> },
): Promise<SignedTokenClaims | null> {
  const payload = signer.verify<{ id?: string; email?: string }>(token, {
    purpose,
    allowExpired: true,
  })
  if (!payload?.id || !payload.email) {
    return null
  }

  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    await store.delete(payload.id)
    return null
  }

  return { id: payload.id, email: payload.email }
}
