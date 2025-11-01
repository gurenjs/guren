# Contributing to Guren

Thanks for your interest in improving Guren! We welcome contributions of all sizes, from typo fixes to new features. This guide explains how to get set up and how we review changes.

## Development Setup

1. **Install dependencies**
   ```bash
   bun install
   ```
2. **Start the supporting services**
   ```bash
   bun run db:up
   ```
3. **Run the demo app**
   ```bash
   bun run dev
   ```
   The blog example lives at `http://localhost:3333` and automatically reloads changes.

To stop the database container, run `bun run db:down`.

## Running Tests

- Run framework unit tests:
  ```bash
  bun run test:bun
  ```
- Run example application tests:
  ```bash
  bun run test:examples
  ```
- Run the full suite (used in CI):
  ```bash
  bun run test
  ```

Before opening a pull request, please run `bun run build` to ensure all packages compile.

## Workflow

1. **Fork & branch** – Create a topic branch from `main`.
2. **Make changes** – Follow the prevailing coding style. Add or update tests whenever you change behaviour.
3. **Commit** – Follow the [commit message convention](#commit-message-convention).
4. **Open a pull request** – Fill out the template and describe what problem is being solved.
5. **Code review** – A maintainer will review your changes. Please respond to feedback promptly.

## Commit Message Convention

We use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(optional scope): <summary>
```

- **type**: `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `perf`, `chore`, or `revert`.
- **scope**: optional package or area (e.g. `server`, `orm`, `docs`).
- **summary**: short, imperative phrase under 60 characters (e.g. `add login controller tests`).
- Use a blank line before the body/footers, and wrap body text at ~72 columns.
- Reference issues with `Refs: #123` or `Fixes: #123` footers when appropriate.

Example:

```
feat(server): support inertia redirects

Add redirect helpers that wrap the underlying Hono response object so
Inertia controllers can return redirects without repeating boilerplate.
```

## Reporting Issues

If you find a bug or have an idea for an improvement, open an issue on GitHub. Include reproduction steps, logs, or screenshots whenever possible.

## Code of Conduct

By participating in this project you agree to uphold our [Code of Conduct](./CODE_OF_CONDUCT.md). Please report unacceptable behaviour to the maintainers listed there.
