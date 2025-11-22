# Testing Guide

Guren ships with two different styles of automated tests:

- **Framework unit/integration tests** live inside the packages (for example `packages/server/tests`). These run with Bun’s native `bun test` runner.
- **Example application tests** (such as the blog demo under `examples/blog`) use Vitest and jsdom so that React components render the same way they would in the browser.

Because the runners have different expectations, run them the way they were designed:

```bash
# Framework packages – Bun’s test runner
bun test packages/server/tests

# Example blog – Vitest + jsdom
bun run --cwd examples/blog test
```

### Writing Bun tests for framework packages

Framework tests rely on Bun’s built-in assertions from `bun:test`. They help validate lower-level utilities such as the routing registry or HTTP helpers without needing a full application boot.

Common patterns:

- Instantiate controllers and call `setContext(ctx)` with a stubbed Hono context before invoking actions.
- Use lightweight fakes (for example an in-memory ORM adapter) to cover success and failure paths.
- Prefer focused unit tests inside the package that owns the code; use higher-level application tests sparingly to keep the inner loop fast.

Need a starting point? Run the generator:

```bash
# Bun-style test file under tests/
bunx guren make:test server/http/request --runner bun

# Vitest-style test file for SPA code
bunx guren make:test blog/pages/Login
```

The command writes scaffold files beneath `tests/` (creating directories as needed) and defaults to Vitest unless you override `--runner bun`.

### Testing controllers with `@guren/testing`

The `@guren/testing` package provides helpers tailored for controller testing, including:

- `createControllerContext(url, init?)` – builds a controller-ready Hono context.
- `createGurenControllerModule()` – mocks the `guren` package when running in Vitest so you can test controllers in isolation.
- `createControllerModuleMock()` – drop-in mock for `@guren/server` with `Controller`, `json`, and `redirect` wired for Vitest.
- `readInertiaResponse(response)` – normalizes Inertia responses into `{ format, payload, body }` for easy assertions.

Import these utilities in Vitest suites (for example under `examples/blog/tests`) to keep React/Inertia controller tests expressive while avoiding Bun-specific APIs.

### Troubleshooting

- Seeing `vi.mock is not a function`? That test is running under Bun; switch to the Vitest command shown above.
- Hitting `ReferenceError: document is not defined` indicates a DOM-dependent test is running outside jsdom. Use the Vitest runner or set up jsdom explicitly.

Keeping the runners separate ensures you get fast feedback from Bun for framework code and realistic DOM behavior for SPA tests.
