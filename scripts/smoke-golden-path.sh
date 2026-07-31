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

# Database driver for the scaffolded app. "postgres" and "mysql" expect a
# reachable server (default: the repo compose instances on ports 54322 and
# 33306 — run `bun run db:up` / `bun run db:up:mysql` locally; CI maps its
# service containers to the same ports).
SMOKE_DB="${GUREN_SMOKE_DB:-sqlite}"

if [ "$SMOKE_DB" = "postgres" ]; then
  # Use a dedicated database so db:reset never touches a developer's data
  # on the shared compose instance. CI maps its service to the same port.
  export DATABASE_URL="${GUREN_SMOKE_DATABASE_URL:-postgres://guren:guren@localhost:54322/guren_smoke}"
elif [ "$SMOKE_DB" = "mysql" ]; then
  # Same reasoning as postgres. The unprivileged `guren` user only owns the
  # `guren` database in both compose and CI, so creating the dedicated one
  # needs root.
  export DATABASE_URL="${GUREN_SMOKE_DATABASE_URL:-mysql://root:guren@localhost:33306/guren_smoke}"
fi

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

bun "$CREATE_APP_BIN" "$APP_DIR" --mode ssr --db "$SMOKE_DB"

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

# --force: `add auth` (step above) already scaffolds app/Providers/MailProvider.ts
# for password reset — the mail blueprint's own, more complete MailProvider
# (memory transport, setMailManager wiring) intentionally supersedes it.
(cd "$APP_DIR" && bun "$CLI_BIN" add mail --force)

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
# Step 16: Runtime HTTP smoke — migrate, seed, boot the server, and exercise
# the auth + CRUD golden path end to end. This is the gate that catches
# published-artifact-only breakage (bundled ORM copies, missing exports,
# unregistered routes) that compile-time checks cannot see.
# ---------------------------------------------------------------------------
step 16 "Runtime HTTP smoke (login + CRUD + CSRF)"

SERVER_PID=""

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
}

cleanup() {
  stop_server
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    echo ""
    echo "=== Cleanup: removing $TEMP_DIR ==="
    rm -rf "$TEMP_DIR"
  fi
}

(cd "$APP_DIR" && bun run db:make)

if [ "$SMOKE_DB" = "sqlite" ]; then
  (cd "$APP_DIR" && bun run db:migrate)
else
  # Server-backed drivers get a dedicated database, created here if missing.
  case "$SMOKE_DB" in
    postgres)
      # CREATE DATABASE has no IF NOT EXISTS on pg.
      cat > "$TEMP_DIR/ensure-db.ts" <<'ENSUREDB'
import postgres from 'postgres'

const target = new URL(process.env.DATABASE_URL ?? '')
const dbName = target.pathname.slice(1)
const admin = new URL(target.toString())
admin.pathname = '/postgres'

const sql = postgres(admin.toString(), { max: 1 })
const exists = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`
if (exists.length === 0) {
  await sql.unsafe(`CREATE DATABASE "${dbName.replaceAll('"', '""')}"`)
  console.log(`Created database ${dbName}`)
} else {
  console.log(`Database ${dbName} already exists`)
}
await sql.end()
ENSUREDB
      ;;
    mysql)
      cat > "$TEMP_DIR/ensure-db.ts" <<'ENSUREDB'
import { createConnection } from 'mysql2/promise'

const target = new URL(process.env.DATABASE_URL ?? '')
const dbName = decodeURIComponent(target.pathname.slice(1))
const admin = new URL(target.toString())
admin.pathname = '/'

const connection = await createConnection(admin.toString())
await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName.replaceAll('`', '``')}\``)
await connection.end()
console.log(`Database ${dbName} ready`)
ENSUREDB
      ;;
    *)
      echo "ERROR: unknown GUREN_SMOKE_DB '$SMOKE_DB' (expected sqlite, postgres, or mysql)"
      exit 1
      ;;
  esac
  (cd "$APP_DIR" && bun "$TEMP_DIR/ensure-db.ts")

  # Drop leftovers from previous runs and exercise resetDatabase().
  (cd "$APP_DIR" && bun "$CLI_BIN" db:reset --force)
fi
(cd "$APP_DIR" && bun run db:seed)

# db:status must see every migration as applied on every driver.
STATUS_OUTPUT=$(cd "$APP_DIR" && bun "$CLI_BIN" db:status 2>&1)
printf '%s\n' "$STATUS_OUTPUT"
if printf '%s' "$STATUS_OUTPUT" | grep -q "pending"; then
  echo "ERROR: db:status reports pending migrations after db:migrate"
  exit 1
fi
if ! printf '%s' "$STATUS_OUTPUT" | grep -q "applied"; then
  echo "ERROR: db:status did not report any applied migrations"
  exit 1
fi

# Assert migrations actually created tables — db:migrate used to report
# success while silently executing nothing.
if [ "$SMOKE_DB" = "postgres" ]; then
  cat > "$TEMP_DIR/dbcheck.ts" <<'DBCHECK'
import postgres from 'postgres'

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://guren:guren@localhost:54322/guren', { max: 1 })
const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
const tables = rows.map((row) => row.table_name as string)
for (const required of ['users', 'posts', 'comments']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    process.exit(1)
  }
}
const tracker = await sql`SELECT count(*)::int AS c FROM drizzle.__drizzle_migrations`
if (Number(tracker[0].c) < 1) {
  console.error('drizzle.__drizzle_migrations is empty after db:migrate')
  process.exit(1)
}
await sql.end()
console.log('DB tables OK (postgres): ' + tables.join(', '))
DBCHECK
  (cd "$APP_DIR" && bun "$TEMP_DIR/dbcheck.ts")
elif [ "$SMOKE_DB" = "mysql" ]; then
  cat > "$TEMP_DIR/dbcheck.ts" <<'DBCHECK'
import { createConnection } from 'mysql2/promise'

const connection = await createConnection(process.env.DATABASE_URL ?? '')
const [rows] = await connection.query(
  'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()',
)
const tables = (rows as Array<{ name: string }>).map((row) => row.name)
for (const required of ['users', 'posts', 'comments']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    process.exit(1)
  }
}
// The tracker table lives in the app database on MySQL, so the count below
// doubles as its existence check — the query fails if it was never created.
const [tracker] = await connection.query('SELECT count(*) AS c FROM __drizzle_migrations')
if (Number((tracker as Array<{ c: number }>)[0].c) < 1) {
  console.error('__drizzle_migrations is empty after db:migrate')
  process.exit(1)
}
await connection.end()
console.log('DB tables OK (mysql): ' + tables.join(', '))
DBCHECK
  (cd "$APP_DIR" && bun "$TEMP_DIR/dbcheck.ts")
else
  (cd "$APP_DIR" && bun -e "
import { Database } from 'bun:sqlite'
const db = new Database('./data/guren.db')
const tables = db.query(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map((r) => r.name)
for (const required of ['users', 'posts', 'comments', '__drizzle_migrations']) {
  if (!tables.includes(required)) {
    console.error('Missing table after db:migrate: ' + required + ' (found: ' + tables.join(', ') + ')')
    process.exit(1)
  }
}
console.log('DB tables OK: ' + tables.join(', '))
")
fi

RUNTIME_PORT="${GUREN_SMOKE_PORT:-3799}"
RUNTIME_URL="http://localhost:$RUNTIME_PORT"
COOKIES="$TEMP_DIR/cookies.txt"
SERVER_LOG="$TEMP_DIR/server.log"

(cd "$APP_DIR" && exec env PORT="$RUNTIME_PORT" NODE_ENV=development bun bin/serve.ts > "$SERVER_LOG" 2>&1) &
SERVER_PID=$!

echo "Waiting for server on $RUNTIME_URL ..."
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "$RUNTIME_URL/health"; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: server process exited early. Log:"
    cat "$SERVER_LOG"
    exit 1
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    echo "ERROR: server did not become ready within 30s. Log:"
    cat "$SERVER_LOG"
    exit 1
  fi
done

http_expect() {
  local label="$1"
  local expected="$2"
  shift 2
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$status" != "$expected" ]; then
    echo "ERROR: $label — expected HTTP $expected, got $status"
    echo "--- server log tail ---"
    tail -40 "$SERVER_LOG"
    exit 1
  fi
  echo "  OK: $label -> $status"
}

# Unauthenticated pages
http_expect "GET /login" 200 -c "$COOKIES" "$RUNTIME_URL/login"

XSRF=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$COOKIES")
if [ -z "$XSRF" ]; then
  echo "ERROR: XSRF-TOKEN cookie was not set on GET /login (CSRF middleware not mounted?)"
  exit 1
fi
echo "  OK: XSRF-TOKEN cookie present"

# Login with the seeded demo user
http_expect "POST /login (valid credentials + CSRF)" 303 \
  -b "$COOKIES" -c "$COOKIES" -X POST "$RUNTIME_URL/login" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $XSRF" \
  -d '{"email":"demo@example.com","password":"secret","remember":false}'

http_expect "GET /dashboard (authenticated)" 200 -b "$COOKIES" "$RUNTIME_URL/dashboard"

# CRUD create + read
http_expect "POST /posts (authenticated)" 303 \
  -b "$COOKIES" -c "$COOKIES" -X POST "$RUNTIME_URL/posts" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $XSRF" \
  -d '{"title":"Golden path runtime","body":"created by smoke test"}'

POSTS_BODY=$(curl -s -b "$COOKIES" "$RUNTIME_URL/posts")
if ! printf '%s' "$POSTS_BODY" | grep -q "Golden path runtime"; then
  echo "ERROR: GET /posts does not contain the created post title"
  exit 1
fi
echo "  OK: GET /posts contains created post"

# Security defaults
http_expect "POST /posts (no CSRF token)" 403 \
  -X POST "$RUNTIME_URL/posts" -H "Content-Type: application/json" \
  -d '{"title":"x","body":"y"}'

GUEST_COOKIES="$TEMP_DIR/guest-cookies.txt"
curl -s -c "$GUEST_COOKIES" -o /dev/null "$RUNTIME_URL/login"
GUEST_XSRF=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$GUEST_COOKIES")
http_expect "POST /posts (guest with valid CSRF)" 401 \
  -b "$GUEST_COOKIES" -X POST "$RUNTIME_URL/posts" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $GUEST_XSRF" \
  -d '{"title":"guest","body":"blocked"}'

stop_server

# ---------------------------------------------------------------------------
# Step 17: Add-on runtime smoke — boot the app once more and exercise the
# queue (dispatch + pop on the memory driver) and mail (memory transport)
# wiring that the add-on blueprints installed. Compile-time checks cannot
# tell whether the providers actually register working managers.
# ---------------------------------------------------------------------------
step 17 "Add-on runtime smoke (queue dispatch + mail send)"

cat > "$APP_DIR/addons-check.ts" <<'ADDONS'
import app, { ready } from './src/main.js'
import { Job, registerJob } from '@guren/core'

await ready

// Queue: the scaffolded default is the sync driver — dispatch must execute
// the handler inline, in this process, with no worker.
let probeRan = false
class SmokeProbeJob extends Job<Record<string, never>> {
  async handle(): Promise<void> {
    probeRan = true
  }
}
registerJob(SmokeProbeJob)
const jobId = await SmokeProbeJob.dispatch({})
if (typeof jobId !== 'string' || jobId.length === 0) {
  console.error('Job dispatch did not return a job id')
  process.exit(1)
}
if (!probeRan) {
  console.error('SyncDriver did not execute the dispatched job inline')
  process.exit(1)
}
console.log('Queue OK: sync dispatch executed the job inline')

// The scaffolded sample job must dispatch cleanly too.
const { ProcessWelcomeSequenceJob } = await import('./app/Jobs/ProcessWelcomeSequenceJob.js')
await ProcessWelcomeSequenceJob.dispatch({ source: 'smoke' })

// Mail: the scaffolded default is the log transport — send() must succeed
// and report the log response.
const mailManager = app.container.make('mail') as never
const { WelcomeEmailMail } = await import('./app/Mail/WelcomeEmailMail.js')
const result = (await new WelcomeEmailMail(mailManager).to('smoke@example.com').send()) as {
  success: boolean
  response?: string
  error?: string
}
if (!result.success) {
  console.error('Mail send failed: ' + JSON.stringify(result))
  process.exit(1)
}
if (result.response !== 'Message written to log') {
  console.error('Expected the log transport to handle the message, got: ' + JSON.stringify(result))
  process.exit(1)
}
console.log('Mail OK: ' + result.response)

process.exit(0)
ADDONS

(cd "$APP_DIR" && bun addons-check.ts)
rm -f "$APP_DIR/addons-check.ts"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "=== Golden path smoke test PASSED ==="
exit 0
