/**
 * A real `.guren/agents.gen.ts`, pasted verbatim below this comment.
 *
 * The reason is *compile-time*: `agentTools` is emitted `as const`, so every
 * property is `readonly` and every value a literal type, and
 * `registerAgentTools(agentTools)` is the assignment nothing else in the repo
 * performs — tests building fixtures through `deriveAgentTools()` get mutable
 * `DerivedAgentTool` objects that satisfy `WebMcpToolSource` trivially.
 * Produced by `buildAgentToolsContent()`; regenerate rather than hand-edit.
 */

// oxlint-disable-next-line guren/comment-length -- generated text compared byte for byte by packages/cli/tests/agents-manifest-fixture.test.ts
/**
 * Agent tools derived from the routes that declare `.agent()` metadata
 * (RFC 0016). Every field here comes from a contract the route already
 * carries — nothing is restated by hand, so a tool cannot advertise a schema
 * the endpoint does not validate.
 *
 * `inputSchema` merges the route's `params`, `query` and `body` schemas into
 * one JSON Schema 2020-12 object, with path parameters supplemented as
 * required strings; it describes what a caller *sends*, so a coercing schema
 * appears as the type it accepts. `inputSources` records which of those
 * contracts each merged property came from, and `inputBodyNested` marks a
 * route whose non-object body was nested under a `body` key to give the tool
 * an object root; together they are what lets a client rebuild the HTTP
 * request from a flat tool call. `outputSchema` is present only for routes
 * that bind an `output` schema — the one shape validated at runtime. Routes
 * that instead declare a `resource` hint carry its payload type in the
 * description and in {@link AgentToolOutputTypes}.
 *
 * `annotations` are MCP `ToolAnnotations`, resolved to explicit values. They
 * are hints for client UX, never enforcement: authorization lives in policies
 * and scopes, and `authorization.ability` here reports the policy ability the
 * route's middleware chain checks, when that is statically derivable.
 */
export const agentTools = {
  'comments.store': {
    toolName: "comments.store",
    routeName: "comments.store",
    method: "POST",
    path: "/posts/:id/comments",
    description: "Comment on a post.",
    inputSchema: {
      "type": "object",
      "properties": {
        "id": {
          "type": "number"
        },
        "text": {
          "type": "string",
          "minLength": 1
        }
      },
      "required": [
        "id",
        "text"
      ]
    },
    inputSources: {
      "id": "params",
      "text": "body"
    },
    inputBodyNested: false,
    annotations: {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false
    },
    authorization: {
      "ability": "create-comment"
    },
    redact: [
      "text"
    ],
    expose: {
      "mcp": true,
      "webMcp": true
    },
  },
  'internal.index': {
    toolName: "internal.index",
    routeName: "internal.index",
    method: "GET",
    path: "/internal",
    inputSchema: {
      "type": "object",
      "properties": {}
    },
    inputSources: {},
    inputBodyNested: false,
    annotations: {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true
    },
    expose: {
      "mcp": true,
      "webMcp": false
    },
  },
  'payouts.store': {
    toolName: "payouts.store",
    routeName: "payouts.store",
    method: "POST",
    path: "/payouts",
    inputSchema: {
      "type": "object",
      "properties": {}
    },
    inputSources: {},
    inputBodyNested: false,
    annotations: {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false
    },
    approval: "required",
    expose: {
      "mcp": true,
      "webMcp": true
    },
  },
  'posts.bulk': {
    toolName: "posts.bulk",
    routeName: "posts.bulk",
    method: "POST",
    path: "/posts/bulk",
    inputSchema: {
      "type": "object",
      "properties": {
        "body": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "body"
      ]
    },
    inputSources: {
      "body": "body"
    },
    inputBodyNested: true,
    annotations: {
      "readOnlyHint": false,
      "destructiveHint": true,
      "idempotentHint": false
    },
    expose: {
      "mcp": true,
      "webMcp": true
    },
  },
  'posts.index': {
    toolName: "posts.index",
    routeName: "posts.index",
    method: "GET",
    path: "/posts",
    description: "List posts.",
    inputSchema: {
      "type": "object",
      "properties": {
        "page": {
          "type": "number"
        }
      }
    },
    inputSources: {
      "page": "query"
    },
    inputBodyNested: false,
    annotations: {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true
    },
    expose: {
      "mcp": true,
      "webMcp": true
    },
  },
  'posts.summary': {
    toolName: "posts.summary",
    routeName: "posts.summary",
    method: "GET",
    path: "/posts/summary",
    inputSchema: {
      "type": "object",
      "properties": {}
    },
    inputSources: {},
    inputBodyNested: false,
    outputSchema: {
      "type": "object",
      "properties": {
        "total": {
          "type": "number"
        }
      },
      "required": [
        "total"
      ]
    },
    annotations: {
      "readOnlyHint": true,
      "destructiveHint": false,
      "idempotentHint": true
    },
    expose: {
      "mcp": true,
      "webMcp": true
    },
  },
} as const

export type AgentToolName = keyof typeof agentTools

/**
 * The payload shape each tool's route declares through a `resource` response
 * hint — declared, not validated: the server never checks its response
 * against this. Tools that bind an `output` schema are absent; their
 * `outputSchema` is the enforced contract and needs no type-level twin.
 */
export interface AgentToolOutputTypes {
  // No tool declares a resolvable resource response hint.
}
