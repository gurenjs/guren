# Serverless Deployment

## Supported: AWS Lambda

Guren provides first-class AWS Lambda support via `@guren/server/lambda`. The adapter handles API Gateway and ALB events, SQS queue processing, and EventBridge scheduled tasks.

See the full guide: [docs/en/guides/serverless.md](../../docs/en/guides/serverless.md)

Quick start:

```typescript
// lambda.ts
import app from './src/app'
import { createLambdaHandler } from '@guren/core/lambda'

await app.boot()
export const handler = createLambdaHandler(app)
```

### Infrastructure recommendations

- **HTTP**: API Gateway v2 (HTTP API) or Application Load Balancer
- **Database**: RDS PostgreSQL or Aurora Serverless v2
- **Sessions/Cache**: ElastiCache Redis (not in-memory stores)
- **Static assets**: S3 + CloudFront (do not serve through Lambda)
- **Password hashing**: Use `NodeHasher` instead of `ScryptHasher` on Node.js runtimes

## Not Supported

### Cloudflare Workers

Cloudflare Workers use the `workerd` runtime, which lacks several Node.js APIs that Guren depends on. Key incompatibilities:

- No native `node:crypto` support required by session and encryption subsystems
- No `node:fs` access needed by view resolution and asset loading
- Connection pooling model differs from what Drizzle ORM expects

### Vercel Edge Functions

Vercel Edge Functions run on V8 isolates (similar limitations to Workers). Additionally, Guren relies on Bun-specific APIs for hashing and file operations that are unavailable in the Edge runtime.

### Deno Deploy

While Deno has broader Node.js compatibility, Guren uses Bun-native APIs (`Bun.file`, `Bun.password`, etc.) that do not have Deno equivalents.

## Recommended Alternatives for Container-Based Serverless

If you want serverless scaling without Lambda's cold-start constraints, deploy the standard Docker image to a container-based platform:

| Platform | Service | Notes |
|----------|---------|-------|
| AWS | ECS Fargate | Use the `deploy/docker/Dockerfile`; scales to zero with Fargate Spot |
| GCP | Cloud Run | Supports Bun images; automatic HTTPS and scaling |
| Azure | Container Apps | Bun images work; integrates with Azure Database for PostgreSQL |
| Fly.io | Machines | See `deploy/fly/` recipe; scale-to-zero with Fly Machines |

These platforms run the full Bun runtime, so every Guren feature works without adaptation.
