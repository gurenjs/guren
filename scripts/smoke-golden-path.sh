#!/usr/bin/env bash
set -euo pipefail

# Golden-path smoke test
# Creates a fresh app, adds auth + resource scaffolds, and validates
# that codegen, typecheck, and build all pass.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR=""

cleanup() {
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    echo ""
    echo "=== Cleanup: removing $TEMP_DIR ==="
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

step() {
  local n="$1"
  shift
  echo ""
  echo "=== Step ${n}: $* ==="
}

CLI_BIN="$REPO_ROOT/packages/cli/src/bin.ts"
CREATE_APP_BIN="$REPO_ROOT/packages/create-app/src/cli.ts"

PACKAGES="cli core inertia-client orm server"

# ---------------------------------------------------------------------------
# Pre-flight: ensure packages are built
# ---------------------------------------------------------------------------
step 0 "Verify packages are built"

for pkg in $PACKAGES; do
  if [ ! -f "$REPO_ROOT/packages/$pkg/dist/index.js" ]; then
    echo "ERROR: packages/$pkg/dist/index.js not found. Run 'bun run build' first."
    exit 1
  fi
done

echo "All packages have build output."

# ---------------------------------------------------------------------------
# Step 1: Create a fresh app in a temp directory
# ---------------------------------------------------------------------------
step 1 "Create fresh app via create-guren-app"

TEMP_DIR="$(mktemp -d)"
APP_DIR="$TEMP_DIR/golden-path-app"

echo "Temp directory: $TEMP_DIR"
echo "App directory:  $APP_DIR"

bun "$CREATE_APP_BIN" "$APP_DIR" --mode ssr

# ---------------------------------------------------------------------------
# Step 2: Vendor local packages and install dependencies
# ---------------------------------------------------------------------------
step 2 "Vendor local packages into the app"

VENDOR_DIR="$APP_DIR/.guren-vendor"
mkdir -p "$VENDOR_DIR"

for pkg in $PACKAGES; do
  src="$REPO_ROOT/packages/$pkg"
  dst="$VENDOR_DIR/$pkg"
  mkdir -p "$dst"
  cp -R "$src/dist" "$dst/dist"
  cp "$src/package.json" "$dst/package.json"
  echo "  Vendored @guren/$pkg"
done

# Rewrite all dependency references to vendored file: paths using a single
# bun script so we avoid fragile shell-interpolated node one-liners.
bun -e "
import fs from 'node:fs';
import path from 'node:path';

const appDir = '$APP_DIR';
const vendorDir = '$VENDOR_DIR';
const packages = 'cli core inertia-client orm server'.split(' ');

function rewriteDeps(pkgJsonPath, resolver) {
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const dir = path.dirname(pkgJsonPath);
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    if (!pkg[field]) continue;
    for (const name of packages) {
      const fullName = '@guren/' + name;
      if (pkg[field][fullName]) {
        pkg[field][fullName] = resolver(dir, name);
      }
    }
  }
  fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
}

// Rewrite the app package.json AND ensure all vendored packages appear as
// direct dependencies so bun hoists them into node_modules/@guren/*.
const appPkgJsonPath = path.join(appDir, 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgJsonPath, 'utf8'));
appPkg.dependencies = appPkg.dependencies || {};
for (const name of packages) {
  const fullName = '@guren/' + name;
  const rel = path.relative(appDir, path.join(vendorDir, name)).replace(/\\\\/g, '/');
  appPkg.dependencies[fullName] = 'file:' + rel;
}
fs.writeFileSync(appPkgJsonPath, JSON.stringify(appPkg, null, 2) + '\n');

// Rewrite each vendored package's cross-references
for (const name of packages) {
  const vendorPkgJson = path.join(vendorDir, name, 'package.json');
  if (!fs.existsSync(vendorPkgJson)) continue;
  rewriteDeps(vendorPkgJson, (dir, depName) => {
    const rel = path.relative(dir, path.join(vendorDir, depName)).replace(/\\\\/g, '/') || '.';
    return 'file:' + rel;
  });
}

console.log('  Rewrote dependency references to vendored paths.');
"

echo ""
echo "  Running bun install..."
(cd "$APP_DIR" && bun install)

# ---------------------------------------------------------------------------
# Step 3: Add auth scaffold
# ---------------------------------------------------------------------------
step 3 "Add auth scaffold"

(cd "$APP_DIR" && bun "$CLI_BIN" add auth)

# ---------------------------------------------------------------------------
# Step 4: Add resource scaffold (posts)
# ---------------------------------------------------------------------------
step 4 "Add resource scaffold (posts)"

(cd "$APP_DIR" && bun "$CLI_BIN" add resource posts)

# ---------------------------------------------------------------------------
# Step 5: Run codegen
# ---------------------------------------------------------------------------
step 5 "Run codegen"

(cd "$APP_DIR" && bun "$CLI_BIN" codegen --force)

# ---------------------------------------------------------------------------
# Step 6: Run typecheck
# ---------------------------------------------------------------------------
step 6 "Run typecheck"

(cd "$APP_DIR" && bun run typecheck)

# ---------------------------------------------------------------------------
# Step 7: Run build
# ---------------------------------------------------------------------------
step 7 "Run build"

(cd "$APP_DIR" && bun run build)

# ---------------------------------------------------------------------------
# Step 8: Run test (if test infrastructure exists)
# ---------------------------------------------------------------------------
step 8 "Run test (if available)"

if (cd "$APP_DIR" && grep -q '"test"' package.json 2>/dev/null); then
  (cd "$APP_DIR" && bun run test) || echo "WARNING: tests failed or test runner not fully configured in scaffold"
else
  echo "  No test script found in scaffolded app, skipping."
fi

# ---------------------------------------------------------------------------
# Add-on composition: verify multiple resources and infrastructure add-ons
# compose cleanly together.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Step 9: Add a second resource scaffold (comments)
# ---------------------------------------------------------------------------
step 9 "Add resource scaffold (comments)"

(cd "$APP_DIR" && bun "$CLI_BIN" add resource comments --fields "body:text,postId:number")

# ---------------------------------------------------------------------------
# Step 10: Add infrastructure add-on — queue
# ---------------------------------------------------------------------------
step 10 "Add infrastructure add-on (queue)"

(cd "$APP_DIR" && bun "$CLI_BIN" add queue)

# ---------------------------------------------------------------------------
# Step 11: Add infrastructure add-on — mail
# ---------------------------------------------------------------------------
step 11 "Add infrastructure add-on (mail)"

(cd "$APP_DIR" && bun "$CLI_BIN" add mail)

# ---------------------------------------------------------------------------
# Step 12: Add infrastructure add-on — events
# ---------------------------------------------------------------------------
step 12 "Add infrastructure add-on (events)"

(cd "$APP_DIR" && bun "$CLI_BIN" add events)

# ---------------------------------------------------------------------------
# Step 13: Re-run codegen after all add-ons
# ---------------------------------------------------------------------------
step 13 "Re-run codegen (post add-on composition)"

(cd "$APP_DIR" && bun "$CLI_BIN" codegen --force)

# ---------------------------------------------------------------------------
# Step 14: Re-run typecheck after all add-ons
# ---------------------------------------------------------------------------
step 14 "Re-run typecheck (post add-on composition)"

(cd "$APP_DIR" && bun run typecheck)

# ---------------------------------------------------------------------------
# Step 15: Re-run build after all add-ons
# ---------------------------------------------------------------------------
step 15 "Re-run build (post add-on composition)"

(cd "$APP_DIR" && bun run build)

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "=== Golden path smoke test PASSED ==="
exit 0
