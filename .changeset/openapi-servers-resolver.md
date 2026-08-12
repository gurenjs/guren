---
'@guren/openapi': minor
---

Accept a function for the `servers` option, resolved every time a document is generated

A mounted document is rendered per request, but `servers` could only be given as a fixed list — so an app could advertise no address it did not already know when the module ran. With `PORT=0` the OS assigns the port during `listen()`, leaving the document pointing generated clients and the Scalar "try it" button at a port nothing is listening on.

`servers` now also accepts `() => Array<string | OpenApiServer>`, called once per generated document:

```ts
let serverUrl = 'http://localhost:3334'

mountOpenApiDocs(app, {
  title: 'Example API',
  version: '1.0.0',
  servers: () => [serverUrl],
})

const address = await app.listen({ port: 0 })
serverUrl = address.url
```

Passing an array behaves exactly as before.
