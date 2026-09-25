/**
 * Which `Request` objects the agent dispatcher built (RFC 0016 §3), keyed on
 * **object identity** like the principal seam in `agent-principal.ts`: a
 * request that crosses a socket arrives as a new object and carries nothing,
 * so seeing the mark means the request was handed to `app.fetch` in this
 * process. Not the `X-Guren-Agent-Surface` header, which any client can send.
 * Not exported from the package index.
 */
const dispatched = new WeakSet<Request>()

/** Mark `request` as built by `buildToolRequest`, returning that same object. */
export function markDispatchedToolRequest(request: Request): Request {
  dispatched.add(request)
  return request
}

/** Whether this exact object was built by the dispatcher in this process. */
export function isDispatchedToolRequest(request: Request): boolean {
  return dispatched.has(request)
}
