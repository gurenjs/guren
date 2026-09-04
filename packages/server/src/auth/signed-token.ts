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

  // Ask again without the expiry check rather than re-deriving the comparison
  // here. The two calls differ only in that one branch, so a token the strict
  // call rejected and this one accepts is expired rather than forged. It also
  // keeps the comparison the signer's: were it to grow clock-skew leeway, the
  // strict call would accept a token inside the window and this path would
  // never delete it.
  const expired = signer.verify<{ id?: string }>(token, { purpose, allowExpired: true })
  if (expired?.id) {
    await store.delete(expired.id)
  }

  return null
}
