---
'create-guren-app': minor
---

A scaffolded app's `build` script now ends with `bunx vite build --mode mcp-app`, which builds one self-contained HTML document per page an `.agent({ ui })` route names (RFC 0038). An app with no such route builds nothing in that step and writes an empty `.guren/mcp-app/index.gen.ts`. An existing app adds the step to its own `build` script when it starts declaring `ui`. The scaffold's `.gitignore` lists `.guren/mcp-app/`, the step's output.
