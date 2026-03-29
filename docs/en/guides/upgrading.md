# Upgrading Guren

Use this guide for minor-to-minor upgrades.

## Upgrade Workflow (Required)

1. Read `CHANGELOG.md` and release notes.
2. Check `docs/en/guides/release-policy.md` compatibility matrix.
3. Update dependencies and regenerate artifacts:

```bash
bun install
bunx guren codegen
```

4. Run validations:

```bash
bun run build
bun run typecheck
bun run test
```

5. Apply migration notes for your source/target versions.

## Minor Migration Notes

### 0.2.x -> 0.3.x

- No additional migration notes yet.
- If your app uses experimental APIs, re-run `bunx guren doctor` and fix warnings.

## Breaking Change Template (for future minors)

For each breaking item, document:

- **What changed**
- **Why**
- **Who is affected**
- **Before/After code examples**
- **One-command verification**
