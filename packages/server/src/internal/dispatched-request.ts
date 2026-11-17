/**
 * Which `Request` objects the agent dispatcher built (RFC 0016 §3), keyed on
 * **object identity** like the principal seam in `agent-principal.ts`: a
 * request that crosses a socket arrives as a new object and carries nothing,
 * so seeing the mark means the request was handed to `app.fetch` in this
 * process. Not `isAgentToolRequest()` in `agent-request.ts`, whose header any
 * client can send: that one only picks the shape of a refusal.
 * Not exported from the package index.
 */

/** The route a dispatched request was built for, as `Router.definitions()` names it. */
export interface DispatchedToolRoute {
  method: string
  path: string
  name: string
}

const dispatched = new WeakMap<Request, DispatchedToolRoute>()

/** Mark `request` as built by `buildToolRequest` for `route`, returning that same object. */
export function markDispatchedToolRequest(request: Request, route: DispatchedToolRoute): Request {
  dispatched.set(request, { method: route.method, path: route.path, name: route.name })
  return request
}

/** Whether this exact object was built by the dispatcher in this process. */
export function isDispatchedToolRequest(request: Request): boolean {
  return dispatched.has(request)
}

/**
 * The route this exact object was built for, or `undefined` for any other
 * request. `Router.mount()` refuses it on every other route: a path parameter
 * equal to an earlier route's literal segment would otherwise run a route the
 * scope and approval gates never judged.
 */
export function readDispatchedToolRoute(request: Request): DispatchedToolRoute | undefined {
  return dispatched.get(request)
}
