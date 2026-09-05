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
  const claims = signer.verify<{ id?: string; email?: string }>(token, { purpose })
  if (claims?.id && claims.email) {
    return { id: claims.id, email: claims.email }
  }

  // Ask again with only the expiry check off, rather than comparing `exp` here:
  // a token the strict call rejected and this one accepts is expired, not
  // forged, and the comparison stays the signer's (if it grows clock-skew
  // leeway, the strict call accepts inside the window and this path never
  // deletes a live token).
  const expired = signer.verify<{ id?: string }>(token, { purpose, allowExpired: true })
  if (expired?.id) {
    await store.delete(expired.id)
  }

  return null
}
