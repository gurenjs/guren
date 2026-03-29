# Commit Message Rules

## Format

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary>

<body>

<footer>
```

## Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `test` | Adding or updating tests |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `build` | Build system or external dependencies |
| `ci` | CI configuration files |
| `perf` | Performance improvement |
| `chore` | Other changes that don't modify src or test |
| `revert` | Reverts a previous commit |

## Scopes

Use package names or areas:

| Scope | Description |
|-------|-------------|
| `server` | @guren/server package |
| `orm` | @guren/orm package |
| `cli` | @guren/cli package |
| `testing` | @guren/testing package |
| `core` | @guren/core package |
| `inertia` | @guren/inertia-client package |
| `create-app` | @guren/create-app package |
| `docs` | Documentation |
| `examples` | Example applications |

## Summary Line

- Use imperative mood ("add" not "added" or "adds")
- Don't capitalize first letter
- No period at the end
- Keep under 60 characters

```
# Good
feat(server): add rate limiting middleware
fix(orm): handle null values in where clause

# Bad
feat(server): Added rate limiting middleware.
fix(orm): Fixes the null value bug
```

## Body (Optional)

- Wrap at ~72 characters
- Explain **what** and **why**, not **how**
- Use blank line to separate from summary

```
feat(server): add session-based authentication

Implement session management using secure cookies. This provides
a foundation for user authentication without requiring external
session stores.

The implementation uses Hono's cookie middleware with HMAC signing
for session integrity.
```

## Footer (Optional)

- Reference issues with `Refs: #123` or `Fixes: #123`
- Breaking changes with `BREAKING CHANGE:`

```
feat(orm)!: change Model.find() return type

BREAKING CHANGE: Model.find() now returns null instead of throwing
when record is not found. Update code to handle null returns.

Fixes: #45
```

## Examples

### Simple Feature
```
feat(cli): add make:middleware command
```

### Bug Fix with Context
```
fix(server): prevent double JSON parsing

The request body was being parsed twice when both middleware and
controller attempted to read it. Cache the parsed result to avoid
duplicate parsing overhead.

Fixes: #78
```

### Documentation
```
docs: update authentication guide

Add examples for session-based auth and API token authentication.
Include middleware configuration and route protection patterns.
```

### Breaking Change
```
feat(orm)!: require explicit table configuration

BREAKING CHANGE: Models must now define static `table` property
instead of inferring from class name.

Before:
  class User extends Model {}

After:
  class User extends Model {
    static table = users
  }
```

### Multiple Scopes
If a change spans multiple packages, use the primary package or omit scope:

```
refactor: unify error handling across packages
```

## Commits to Avoid

```
# Too vague
fix: fix bug
feat: update code

# Not imperative
feat(server): added new feature

# Too long
feat(server): implement comprehensive rate limiting with configurable...
```
