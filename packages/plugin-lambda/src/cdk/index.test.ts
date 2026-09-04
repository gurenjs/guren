import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, Stack } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { DOCUMENT_ASSET_EXTENSIONS, DOCUMENT_ASSET_HEADERS } from '@guren/core/internal/deploy-build'
import { GurenLambdaApp } from './index'

let functionDir: string
let assetsDir: string

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'guren-lambda-cdk-'))
  functionDir = join(root, 'function')
  assetsDir = join(root, 'assets')
  mkdirSync(functionDir, { recursive: true })
  mkdirSync(assetsDir, { recursive: true })
  writeFileSync(join(functionDir, 'handler.js'), 'export const http = () => {}\n')
  writeFileSync(join(functionDir, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(assetsDir, 'robots.txt'), 'User-agent: *\n')
})

afterAll(() => {
  rmSync(join(functionDir, '..'), { recursive: true, force: true })
})

function synth(build: (stack: Stack) => void): Template {
  const app = new App()
  const stack = new Stack(app, 'TestStack')
  build(stack)
  return Template.fromStack(stack)
}

describe('GurenLambdaApp', () => {
  test('should provision an HTTP function behind an HTTP API by default', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir })
    })

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.http',
      Runtime: 'nodejs22.x',
      MemorySize: 512,
      Environment: { Variables: { NODE_ENV: 'production' } },
    })
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1)
    template.resourceCountIs('AWS::SQS::Queue', 0)
    template.resourceCountIs('AWS::Events::Rule', 0)
    template.resourceCountIs('AWS::CloudFront::Distribution', 0)
  })

  test('should wire the queue worker with a DLQ and partial batch failures', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, queue: {} })
    })

    template.resourceCountIs('AWS::SQS::Queue', 2)
    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'handler.queue' })
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      BatchSize: 10,
    })
    template.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: { maxReceiveCount: 3 },
    })
  })

  test('should expose the queue URL to dispatching functions', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, queue: {} })
    })

    const functions = template.findResources('AWS::Lambda::Function')
    const httpFn = Object.values(functions).find(
      (fn) => (fn.Properties as { Handler?: string }).Handler === 'handler.http',
    )
    const env = (httpFn?.Properties as { Environment?: { Variables?: Record<string, unknown> } } | undefined)?.Environment
    expect(env?.Variables?.SQS_QUEUE_URL).toBeDefined()
  })

  test('should provision an EventBridge rule for the scheduler', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, schedule: {} })
    })

    template.hasResourceProperties('AWS::Lambda::Function', { Handler: 'handler.schedule' })
    template.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)' })
  })

  test('should provision a console function with a long timeout', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, console: true })
    })

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.console',
      Timeout: 300,
    })
  })

  test('should serve assets from S3 behind CloudFront with both prefixes', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, assets: { dir: assetsDir } })
    })

    template.resourceCountIs('AWS::S3::Bucket', 1)
    template.resourceCountIs('AWS::CloudFront::Distribution', 1)

    const distributions = template.findResources('AWS::CloudFront::Distribution')
    const config = (Object.values(distributions)[0].Properties as {
      DistributionConfig: { CacheBehaviors: Array<{ PathPattern: string }> }
    }).DistributionConfig
    const patterns = config.CacheBehaviors.map((behavior) => behavior.PathPattern).sort()
    // robots.txt is a root-level staged file — unreachable without its own
    // behavior, because the default origin is the app.
    expect(patterns).toEqual(['/assets/*', '/public/*', '/robots.txt'])
  })

  test('should give the queue six times the worker timeout of visibility', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, queue: {} })
    })

    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 360,
      RedrivePolicy: { maxReceiveCount: 3 },
    })
  })

  test('should expose the queue to the scheduler and console too', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', { functionDir, queue: {}, schedule: {}, console: true })
    })

    const functions = template.findResources('AWS::Lambda::Function')
    for (const handler of ['handler.schedule', 'handler.console']) {
      const fn = Object.values(functions).find(
        (candidate) => (candidate.Properties as { Handler?: string }).Handler === handler,
      )
      const env = (fn?.Properties as { Environment?: { Variables?: Record<string, unknown> } } | undefined)?.Environment
      expect(env?.Variables?.SQS_QUEUE_URL).toBeDefined()
    }
  })

  test('should wire the Data API environment and grants onto every function', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', {
        functionDir,
        console: true,
        dataApi: {
          resourceArn: 'arn:aws:rds:ap-northeast-1:123456789012:cluster:example',
          secretArn: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:example',
          database: 'appdb',
        },
      })
    })

    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'handler.console',
      Environment: {
        Variables: {
          DATABASE_RESOURCE_ARN: 'arn:aws:rds:ap-northeast-1:123456789012:cluster:example',
          DATABASE_SECRET_ARN: 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:example',
          DATABASE_NAME: 'appdb',
        },
      },
    })

    const policies = template.findResources('AWS::IAM::Policy')
    const statements = Object.values(policies).flatMap(
      (policy) => ((policy.Properties as { PolicyDocument?: { Statement?: Array<{ Action?: unknown }> } }).PolicyDocument?.Statement ?? []),
    )
    const actions = statements.flatMap((statement) => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
    expect(actions).toContain('rds-data:ExecuteStatement')
    expect(actions).toContain('secretsmanager:GetSecretValue')
  })

  test('should merge the build-emitted env.json under explicit environment', () => {
    writeFileSync(
      join(functionDir, '../env.json'),
      JSON.stringify({ GUREN_INERTIA_ENTRY: '/assets/app-Abc123.js', DATABASE_NAME: 'from-build' }),
    )

    try {
      const template = synth((stack) => {
        new GurenLambdaApp(stack, 'App', {
          functionDir,
          environment: { DATABASE_NAME: 'from-props' },
        })
      })

      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: {
            NODE_ENV: 'production',
            GUREN_INERTIA_ENTRY: '/assets/app-Abc123.js',
            DATABASE_NAME: 'from-props',
          },
        },
      })
    } finally {
      rmSync(join(functionDir, '../env.json'))
    }
  })

  describe('the asset document guard', () => {
    /**
     * The code CloudFront actually runs, read back out of the synthesized
     * template rather than from the renderer: a guard generated perfectly and
     * never associated with a behavior protects nothing.
     */
    interface AssetDistribution {
      code: string
      behaviors: Array<{ FunctionAssociations?: Array<{ EventType: string }> }>
      defaultBehavior: { FunctionAssociations?: unknown }
    }

    // Synthesized once: the three tests below read three parts of one stack,
    // and each synth stages the function and asset directories from disk.
    let distribution: AssetDistribution

    beforeAll(() => {
      const template = synth((stack) => {
        new GurenLambdaApp(stack, 'App', { functionDir, assets: { dir: assetsDir } })
      })

      const functions = template.findResources('AWS::CloudFront::Function')
      expect(Object.keys(functions)).toHaveLength(1)

      const config = (Object.values(template.findResources('AWS::CloudFront::Distribution'))[0].Properties as {
        DistributionConfig: {
          CacheBehaviors: AssetDistribution['behaviors']
          DefaultCacheBehavior: AssetDistribution['defaultBehavior']
        }
      }).DistributionConfig

      distribution = {
        code: (Object.values(functions)[0].Properties as { FunctionCode: string }).FunctionCode,
        behaviors: config.CacheBehaviors,
        defaultBehavior: config.DefaultCacheBehavior,
      }
    })

    /** Run the emitted handler the way CloudFront does, on a viewer response. */
    function respondTo(code: string, uri: string): Record<string, { value: string }> {
      const handler = new Function('event', `${code}\nreturn handler(event)`) as (event: unknown) => {
        headers: Record<string, { value: string }>
      }

      return handler({ request: { uri }, response: { headers: {} } }).headers
    }

    const expectedHeaders = Object.fromEntries(
      Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => [name.toLowerCase(), { value }]),
    )

    test('should run on every asset behavior and on none of the app', () => {
      const { behaviors, defaultBehavior } = distribution

      expect(behaviors.length).toBeGreaterThan(0)
      for (const behavior of behaviors) {
        expect(behavior.FunctionAssociations?.map((association) => association.EventType)).toEqual([
          'viewer-response',
        ])
      }
      // The default behavior is the app: its responses already carry the
      // framework's own guard, and a rule reaching them would put
      // `attachment` on a dynamic /sitemap.xml.
      expect(defaultBehavior.FunctionAssociations).toBeUndefined()
    })

    test('should download every document extension the framework guards', () => {
      const { code } = distribution

      // Derived rather than restated: the emitted code has to cover the whole
      // list, so a renderer that drops one — or an extension its matcher cannot
      // express — fails here. The server's own tests keep the list honest,
      // recomputing it from Hono's mime table.
      for (const extension of DOCUMENT_ASSET_EXTENSIONS) {
        expect(respondTo(code, `/uploads/nested/note.${extension}`)).toEqual(expectedHeaders)
        // getMimeType lowercases before its lookup, so the framework guard
        // fires for an uppercase extension and this must too.
        expect(respondTo(code, `/note.${extension.toUpperCase()}`)).toEqual(expectedHeaders)
      }
    })

    test('should download a document reached through a percent-encoded path', () => {
      // CloudFront hands the function the raw path while S3 resolves the
      // encoding when it matches a key, so these reach the same objects the
      // plain paths do.
      expect(respondTo(distribution.code, '/uploads/evil%2Esvg')).toEqual(expectedHeaders)
      expect(respondTo(distribution.code, '/uploads/evil.%73vg')).toEqual(expectedHeaders)
      // A malformed sequence must not throw out of the handler: CloudFront
      // answers a function error with a 502, which would take every asset
      // response down with it.
      expect(respondTo(distribution.code, '/uploads/%zz.svg')).toEqual(expectedHeaders)
      expect(respondTo(distribution.code, '/uploads/%zz.js')).toEqual({})
    })

    test('should leave everything else inline', () => {
      const { code } = distribution

      for (const uri of ['/assets/app-Abc123.js', '/logo.png', '/robots.txt', '/health', '/v1.2/app']) {
        expect(respondTo(code, uri)).toEqual({})
      }
    })
  })

  test('should honor shared environment and sizing overrides', () => {
    const template = synth((stack) => {
      new GurenLambdaApp(stack, 'App', {
        functionDir,
        memorySize: 1024,
        environment: { DATABASE_NAME: 'appdb' },
      })
    })

    template.hasResourceProperties('AWS::Lambda::Function', {
      MemorySize: 1024,
      Environment: { Variables: { NODE_ENV: 'production', DATABASE_NAME: 'appdb' } },
    })
  })
})
