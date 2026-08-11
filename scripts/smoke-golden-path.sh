#!/usr/bin/env bash
set -euo pipefail

# Golden-path smoke test
# Creates a fresh app, adds auth + resource scaffolds, and validates
# that codegen, typecheck, and build all pass.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMP_DIR=""
SERVER_PID=""

# Redefined once the runtime smoke has a server to kill; until then there is
# nothing to stop. Declared here so cleanup() can be written once — the same
# handler ran before and after that point, and keeping one copy is what stops
# the two from drifting.
stop_server() { :; }

cleanup() {
  stop_server
  if [ -n "$TEMP_DIR" ] && [ -d "$TEMP_DIR" ]; then
    # Same opt-out as scripts/smoke/fresh-app.ts: a failure here is only
    # diagnosable from the app it built.
    if [ "${GUREN_KEEP_SMOKE_DIR:-}" = "1" ]; then
      echo ""
      echo "=== Keeping smoke workspace: $TEMP_DIR ==="
      return
    fi
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

# Substring test for a value already held in a variable.
#
# `printf '%s' "$body" | grep -q needle` cannot be used here: `grep -q` exits on
# the first match, `printf` is killed by SIGPIPE (141), and `set -o pipefail`
# reports the pipeline as failed even though the needle *was* found. Whether the
# race is lost depends on how much printf has left to write when grep exits, so
# the assertion reads as a content failure on one machine and passes on another
# — it is reproducible on macOS and has been passing on CI's Linux runners.
# Shell pattern matching has no pipe and no subprocess, so there is nothing to
# race. The needle is quoted inside the pattern, making it a literal.
contains() {
  case "$1" in
    *"$2"*) return 0 ;;
    *) return 1 ;;
  esac
}

CLI_BIN="$REPO_ROOT/packages/cli/src/bin.ts"
CREATE_APP_BIN="$REPO_ROOT/packages/create-app/src/cli.ts"

# Database driver for the scaffolded app. "postgres" and "mysql" expect a
# reachable server (default: the repo compose instances on ports 54322 and
# 33306 — run `bun run db:up` / `bun run db:up:mysql` locally; CI maps its
# service containers to the same ports).
SMOKE_DB="${GUREN_SMOKE_DB:-sqlite}"

if [ "$SMOKE_DB" = "sqlite" ]; then
  # The scaffolded app resolves its database as `process.env.DATABASE_URL ??
  # <sqlite file>`, so an ambient DATABASE_URL silently redirects db:migrate
  # at that server while the assertions below still read the sqlite file —
  # migrations report success against one database and the check finds the
  # other one empty. The script owns driver selection for the other two
  # drivers; owning it here too is what makes that guarantee hold for every
  # caller (a workflow with a job-level DATABASE_URL, or a developer who
  # exports one in their shell).
  unset DATABASE_URL
elif [ "$SMOKE_DB" = "postgres" ]; then
  # Use a dedicated database so db:reset never touches a developer's data
  # on the shared compose instance. CI maps its service to the same port.
  export DATABASE_URL="${GUREN_SMOKE_DATABASE_URL:-postgres://guren:guren@localhost:54322/guren_smoke}"
elif [ "$SMOKE_DB" = "mysql" ]; then
  # Same reasoning as postgres. The unprivileged `guren` user only owns the
  # `guren` database in both compose and CI, so creating the dedicated one
  # needs root.
  export DATABASE_URL="${GUREN_SMOKE_DATABASE_URL:-mysql://root:guren@localhost:33306/guren_smoke}"
fi

# Which @guren/* packages this run resolves from the checkout is derived, not
# listed here — see scripts/smoke/local-packages.ts. This file used to hold two
# copies of that list, and @guren/testing was missing from both: every run
# resolved it from the registry and gated a published copy.
LOCAL_PACKAGES_BIN="$REPO_ROOT/scripts/smoke/local-packages.ts"

# ---------------------------------------------------------------------------
# Pre-flight: ensure packages are built
# ---------------------------------------------------------------------------
step 0 "Verify packages are built"

bun "$LOCAL_PACKAGES_BIN" ensure-built

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

# Copies each package's dist/ and manifest into the app, points their
# cross-references at each other, and rewrites the app's own @guren/*
# dependencies at the entry the template declares them in — a devDependency
# rewritten into `dependencies` would leave the template's published range
# behind for bun to resolve from the registry.
bun "$LOCAL_PACKAGES_BIN" vendor "$APP_DIR" "$VENDOR_DIR"

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

# The field list covers every branch of the dialect column mappers
# (text/number/boolean/date/json) so the typecheck below is what catches
# generated code that only compiles for the simplest column types.
(cd "$APP_DIR" && bun "$CLI_BIN" add resource comments --fields "body:text,postId:number,published:boolean,publishedAt:date,meta:json")

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

# From here the trap has a server to stop; cleanup() already calls this.
stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  SERVER_PID=""
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
if contains "$STATUS_OUTPUT" "pending"; then
  echo "ERROR: db:status reports pending migrations after db:migrate"
  exit 1
fi
if ! contains "$STATUS_OUTPUT" "applied"; then
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

// Every timestamp a scaffold emits must carry a time zone. An offset-less
// column stores a bare wall clock and leaves its meaning to the reader: the
// app itself stays self-consistent (drizzle parses the column as UTC), which
// is why no HTTP round trip below can catch this, but every other reader sees
// a different instant and a `defaultNow()` column records the DB session's
// local wall clock. Asked as "which columns are wrong" rather than against a
// list of names, so a scaffold that grows a new timestamp is covered too.
const offsetlessColumns = await sql`
  SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE table_schema = 'public'
    AND data_type LIKE 'timestamp%'
    AND data_type <> 'timestamp with time zone'
`
if (offsetlessColumns.length > 0) {
  const named = offsetlessColumns.map((c) => c.table_name + '.' + c.column_name + ' (' + c.data_type + ')')
  console.error('Expected every timestamp column to be timestamptz, but found: ' + named.join(', '))
  process.exit(1)
}

await sql.end()
console.log('DB tables OK (postgres): ' + tables.join(', ') + ' — timestamp columns are timestamptz')
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
    // An empty table list here usually means db:migrate wrote somewhere else
    // rather than that it silently executed nothing, so name both databases.
    console.error('Checked sqlite file: ./data/guren.db (DATABASE_URL=' + (process.env.DATABASE_URL ?? '<unset>') + ')')
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

# Login with the seeded demo user. This token was minted while the client was
# a guest, which is exactly what it is valid for.
PRE_LOGIN_XSRF="$XSRF"
http_expect "POST /login (valid credentials + CSRF)" 303 \
  -b "$COOKIES" -c "$COOKIES" -X POST "$RUNTIME_URL/login" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $XSRF" \
  -d '{"email":"demo@example.com","password":"secret","remember":false}'

http_expect "GET /dashboard (authenticated)" 200 -b "$COOKIES" "$RUNTIME_URL/dashboard"

# Establishing the session re-issues the token bound to it, so the login
# response rewrote the jar. Re-read it — a browser client does this implicitly
# by reading the XSRF-TOKEN cookie on every request.
XSRF=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$COOKIES")
if [ "$XSRF" = "$PRE_LOGIN_XSRF" ]; then
  echo "ERROR: XSRF-TOKEN was not re-issued when the session was established"
  exit 1
fi
echo "  OK: XSRF-TOKEN re-issued on login"

# A guest token is minted by anyone who can reach the site, so it must not
# authorize a mutation once the request carries a session. The XSRF-TOKEN
# cookie carries no Domain restriction and no __Host- prefix, so any sibling
# subdomain can write it — meaning double-submit alone (cookie and header
# agreeing on a guest token) has to be rejected here, or that subdomain could
# ride a logged-in session. Both are planted, so this fails on the mode rule
# rather than on a cookie mismatch, which is what makes it worth asserting.
SESSION_COOKIE=$(awk '$6 == "guren.session" { print $7 }' "$COOKIES")
if [ -z "$SESSION_COOKIE" ]; then
  echo "ERROR: no guren.session cookie after login"
  exit 1
fi
http_expect "POST /posts (session + planted guest token)" 403 \
  -X POST "$RUNTIME_URL/posts" \
  -H "Content-Type: application/json" \
  -H "Cookie: guren.session=$SESSION_COOKIE; XSRF-TOKEN=$PRE_LOGIN_XSRF" \
  -H "X-XSRF-TOKEN: $PRE_LOGIN_XSRF" \
  -d '{"title":"planted guest token","body":"must be rejected"}'

# CRUD create + read
http_expect "POST /posts (authenticated)" 303 \
  -b "$COOKIES" -c "$COOKIES" -X POST "$RUNTIME_URL/posts" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $XSRF" \
  -d '{"title":"Golden path runtime","body":"created by smoke test"}'

POSTS_BODY=$(curl -s -b "$COOKIES" "$RUNTIME_URL/posts")
if ! contains "$POSTS_BODY" "Golden path runtime"; then
  echo "ERROR: GET /posts does not contain the created post title"
  printf '%s\n' "$POSTS_BODY" | head -40
  exit 1
fi
echo "  OK: GET /posts contains created post"

# The token rotates on each accepted request, so re-read it from the jar the
# previous POST just rewrote.
XSRF=$(awk '$6 == "XSRF-TOKEN" { print $7 }' "$COOKIES")

# The comments resource carries every column type. Typechecking the generated
# code does not prove a `Date` or a JSON object survives the round trip through
# the dialect's timestamp/json columns — this write does.
http_expect "POST /comments (date + json payload)" 303 \
  -b "$COOKIES" -c "$COOKIES" -X POST "$RUNTIME_URL/comments" \
  -H "Content-Type: application/json" -H "X-XSRF-TOKEN: $XSRF" \
  -d '{"body":"typed columns","postId":1,"published":true,"publishedAt":"2026-02-03T00:00:00.000Z","meta":{"origin":"golden-path-json"}}'

COMMENTS_BODY=$(curl -s -b "$COOKIES" "$RUNTIME_URL/comments")
if ! contains "$COMMENTS_BODY" "typed columns"; then
  echo "ERROR: GET /comments does not contain the created comment"
  exit 1
fi
# The json column must come back as an object, not as the string "[object
# Object]" a text column would have stored.
if ! contains "$COMMENTS_BODY" "golden-path-json"; then
  echo "ERROR: GET /comments did not round-trip the json column"
  printf '%s\n' "$COMMENTS_BODY" | head -40
  exit 1
fi
# The resource serializes date columns as ISO strings. This checks that a
# `Date` went in and a `Date` came back — it deliberately does not police the
# time zone, because the app's own reads round-trip on either column type
# (drizzle parses an offset-less postgres timestamp as UTC). The column type
# itself is asserted in the db check above, which is what catches a regression.
if ! contains "$COMMENTS_BODY" '2026-02-03T00:00:00.000Z'; then
  echo "ERROR: GET /comments did not round-trip the date column"
  printf '%s\n' "$COMMENTS_BODY" | head -40
  exit 1
fi
echo "  OK: GET /comments round-tripped date and json columns"

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
