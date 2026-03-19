# Health Checks

Guren provides a comprehensive health checking system to monitor your application's dependencies and services. Use health checks to expose a `/health` endpoint for load balancers, orchestrators, and monitoring tools.

## Configuration

Create a health manager and register checks:

```typescript
import { createHealthManager, DatabaseCheck, RedisCheck, MemoryCheck } from '@guren/server'

const health = createHealthManager()

// Register checks
health.register(new DatabaseCheck(db))
health.register(new RedisCheck(redis))
health.register(new MemoryCheck({ thresholdMb: 512 }))

// Run all checks
const report = await health.check()
console.log(report.status) // 'healthy', 'degraded', or 'unhealthy'
```

## Built-in Checks

### Database Check

Verifies database connectivity by executing a simple query:

```typescript
import { DatabaseCheck } from '@guren/server'

// Basic usage
health.register(new DatabaseCheck(db))

// With custom options
health.register(new DatabaseCheck(db, {
  name: 'mysql',           // Custom name (default: 'database')
  query: 'SELECT 1 + 1',   // Custom query (default: 'SELECT 1')
}))
```

### Redis Check

Verifies Redis connectivity:

```typescript
import { RedisCheck } from '@guren/server'

// Basic usage
health.register(new RedisCheck(redis))

// With custom options
health.register(new RedisCheck(redis, {
  name: 'redis-cache',   // Custom name (default: 'redis')
}))
```

### Memory Check

Monitors process memory usage with configurable thresholds:

```typescript
import { MemoryCheck } from '@guren/server'

health.register(new MemoryCheck({
  name: 'memory',              // Check name (default: 'memory')
  thresholdMb: 512,            // Warning threshold (default: 512)
  criticalThresholdMb: 1024,   // Critical threshold (default: 1024)
}))
```

Memory check returns status based on heap usage:
- **healthy**: Below threshold
- **degraded**: Above threshold, below critical
- **unhealthy**: Above critical threshold

### Cache Check

Verifies cache store connectivity:

```typescript
import { CacheCheck } from '@guren/server'

health.register(new CacheCheck(cache, {
  name: 'cache',   // Custom name (default: 'cache')
}))
```

### Storage Check

Verifies storage driver connectivity:

```typescript
import { StorageCheck } from '@guren/server'

health.register(new StorageCheck(storage, {
  name: 'storage',        // Custom name (default: 'storage')
  disk: 'local',          // Disk to check (default: default disk)
  testPath: '.health',    // Test file path (default: '.health')
}))
```

## Custom Checks

### Using CustomCheck

Create checks with a callback function:

```typescript
import { customCheck } from '@guren/server'

// Simple custom check
health.register(customCheck('external-api', async () => {
  try {
    const response = await fetch('https://api.example.com/health')
    if (response.ok) {
      return { status: 'healthy', message: 'API is responding' }
    }
    return { status: 'degraded', message: 'API returned error' }
  } catch (error) {
    return { status: 'unhealthy', message: 'API is unreachable' }
  }
}))

// With metadata
health.register(customCheck('queue-depth', async () => {
  const depth = await getQueueDepth()

  return {
    status: depth < 1000 ? 'healthy' : 'degraded',
    message: `Queue has ${depth} jobs`,
    meta: { depth, maxDepth: 1000 },
  }
}))
```

### Extending HealthCheck Class

For reusable checks, extend the base class:

```typescript
import { HealthCheck, CheckResult } from '@guren/server'

export class ExternalServiceCheck extends HealthCheck {
  readonly name: string

  constructor(
    private url: string,
    private serviceName: string
  ) {
    super()
    this.name = serviceName
  }

  async check(): Promise<CheckResult> {
    try {
      const start = Date.now()
      const response = await fetch(this.url)
      const latency = Date.now() - start

      if (!response.ok) {
        return this.degraded(`Service returned ${response.status}`, { latency })
      }

      if (latency > 1000) {
        return this.degraded('Service responding slowly', { latency })
      }

      return this.healthy('Service is healthy', { latency })
    } catch (error) {
      return this.unhealthy(
        error instanceof Error ? error.message : 'Service unreachable'
      )
    }
  }
}

// Usage
health.register(new ExternalServiceCheck(
  'https://api.stripe.com/health',
  'stripe'
))
```

## Check Options

When registering checks, you can configure options:

```typescript
health.register(check, {
  timeout: 5000,      // Timeout in ms (default: 5000)
  critical: true,     // If true, failure marks overall as unhealthy
})
```

### Critical vs Non-Critical Checks

- **Critical checks**: If unhealthy, the overall status becomes "unhealthy"
- **Non-critical checks**: If unhealthy, the overall status becomes "degraded"

```typescript
// Database is critical - app can't function without it
health.register(new DatabaseCheck(db), { critical: true })

// Cache is nice-to-have - app can still function
health.register(new RedisCheck(redis), { critical: false })
```

## Health Report

The health check returns a report object:

```typescript
const report = await health.check()

console.log(report)
// {
//   status: 'healthy' | 'degraded' | 'unhealthy',
//   timestamp: Date,
//   checks: [
//     {
//       name: 'database',
//       status: 'healthy',
//       message: 'Database connection is healthy',
//       duration: 12,
//       meta: { ... }
//     },
//     // ...
//   ]
// }
```

### Running Specific Checks

```typescript
// Run only specific checks
const report = await health.checkOnly(['database', 'redis'])

// Get a single check result
const dbResult = await health.getCheck('database')
```

## HTTP Middleware

Use the built-in middleware to expose a health endpoint:

```typescript
import { createHealthManager } from '@guren/server'

const health = createHealthManager()
// ... register checks

// In your routes
router.get('/health', health.middleware())

// With options
router.get('/health', health.middleware({
  detailed: true,      // Include check details (default: true)
  checks: ['database'] // Only run specific checks
}))

// Simple endpoint (just status)
router.get('/health/simple', health.middleware({ detailed: false }))
```

### Response Format

**Detailed response (200 OK for healthy/degraded, 503 for unhealthy):**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "checks": [
    {
      "name": "database",
      "status": "healthy",
      "message": "Database connection is healthy",
      "duration": 12,
      "meta": {}
    },
    {
      "name": "memory",
      "status": "healthy",
      "message": "Memory usage normal: 256MB",
      "duration": 1,
      "meta": {
        "usedMb": 256,
        "totalMb": 512,
        "thresholdMb": 512
      }
    }
  ]
}
```

**Simple response:**

```json
{
  "status": "healthy",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## CLI Command

### Run Health Checks

Execute health checks from the command line:

```bash
# Run all health checks
bunx guren health:check

# Run specific checks
bunx guren health:check --checks database,redis

# Output as JSON
bunx guren health:check --json
```

**Output:**
```
Health Check Report
==================

Status: healthy
Timestamp: 2024-01-15T10:30:00.000Z

Checks:
  [OK] database (12ms)
       Database connection is healthy

  [OK] memory (1ms)
       Memory usage normal: 256MB

  [OK] redis (5ms)
       Redis connection is healthy

Overall: 3/3 checks passing
```

## Integration Example

### Complete Setup

```typescript
// app/health.ts
import {
  createHealthManager,
  DatabaseCheck,
  RedisCheck,
  MemoryCheck,
  customCheck,
} from '@guren/server'
import { db } from './database'
import { redis } from './redis'

export const health = createHealthManager()

// Critical checks
health.register(new DatabaseCheck(db), { critical: true })

// Non-critical checks
health.register(new RedisCheck(redis), { critical: false })
health.register(new MemoryCheck({
  thresholdMb: 512,
  criticalThresholdMb: 1024,
}))

// Custom check for external API
health.register(customCheck('payment-api', async () => {
  const response = await fetch('https://api.stripe.com/health')
  return {
    status: response.ok ? 'healthy' : 'degraded',
    message: response.ok ? 'Payment API available' : 'Payment API issues',
  }
}), { critical: false })
```

```typescript
// routes/api.ts
import { health } from '../app/health'

router.get('/health', health.middleware())
router.get('/health/live', health.middleware({ detailed: false }))
router.get('/health/ready', health.middleware({
  checks: ['database'],
  detailed: false,
}))
```

## Best Practices

1. **Separate liveness from readiness** - Use `/health/live` for basic checks and `/health/ready` for full checks
2. **Mark database as critical** - Your app usually can't function without it
3. **Keep checks fast** - Set appropriate timeouts, avoid slow checks
4. **Include metadata** - Help debugging by including relevant metrics
5. **Use for orchestrators** - Kubernetes/Docker can use health endpoints for container health
6. **Monitor degraded state** - Set up alerts for degraded status before it becomes unhealthy
