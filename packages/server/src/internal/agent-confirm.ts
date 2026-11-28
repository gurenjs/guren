/**
 * `.agent({ confirm })` as every reader takes it (RFC 0042 §2.1), in a leaf module:
 * the derivation and the router both ask, and the router cannot import the derivation.
 * Anything but `undefined` and `false` asks: a value this cannot read must not turn
 * the question off. A blank message is dropped, so the default question is asked.
 */
export function readAgentConfirm(declared: unknown): { message?: string } | undefined {
  if (declared === undefined || declared === false) return undefined
  const message = typeof declared === 'object' && declared !== null ? (declared as { message?: unknown }).message : undefined
  return typeof message === 'string' && message.trim() !== '' ? { message } : {}
}
