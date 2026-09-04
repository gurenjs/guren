import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CfnOutput, Duration } from 'aws-cdk-lib'
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import { Construct } from 'constructs'
import { DOCUMENT_ASSET_EXTENSIONS, DOCUMENT_ASSET_HEADERS } from '@guren/core/internal/deploy-build'
import { lambdaHandlerId } from '../handlers'

export interface GurenLambdaQueueProps {
  /** SQS messages delivered per invocation. Defaults to 10. */
  batchSize?: number
  /** Retries before a message lands in the dead-letter queue. Defaults to 3. */
  maxReceiveCount?: number
  /** Worker timeout. Also drives the queue's visibility timeout. Defaults to 60 seconds. */
  timeout?: Duration
}

export interface GurenLambdaScheduleProps {
  /** How often the scheduler handler runs. Defaults to every minute. */
  rate?: Duration
}

export interface GurenLambdaAssetsProps {
  /** The staged assets directory produced by `guren lambda:build` (`.lambda/assets`). */
  dir: string
}

export interface GurenLambdaDataApiProps {
  /** Aurora cluster ARN — exposed as DATABASE_RESOURCE_ARN. */
  resourceArn: string
  /** Secrets Manager secret ARN — exposed as DATABASE_SECRET_ARN. */
  secretArn: string
  /** Database name — exposed as DATABASE_NAME. */
  database?: string
}

export interface GurenLambdaAppProps {
  /** The function directory produced by `guren lambda:build` (`.lambda/function`). */
  functionDir: string
  /** Environment variables shared by every function (DATABASE_*, APP_KEY, ...). */
  environment?: Record<string, string>
  /** Defaults to Node.js 22 — the runtime `lambda:build` bundles for. */
  runtime?: lambda.Runtime
  /** Memory for every function. Defaults to 512 MB. */
  memorySize?: number
  /** HTTP function timeout. Defaults to 30 seconds. */
  timeout?: Duration
  /** Provision SQS + a queue worker wired to the `queue` export. */
  queue?: GurenLambdaQueueProps
  /** Provision an EventBridge rule wired to the `schedule` export. */
  schedule?: GurenLambdaScheduleProps
  /** Provision a console function wired to the `console` export (invoke with `{"command": "db:migrate"}`). */
  console?: boolean
  /** Serve `.lambda/assets` from S3 behind CloudFront, with the app as the default origin. */
  assets?: GurenLambdaAssetsProps
  /** Wire every function to Aurora via the RDS Data API: environment plus the rds-data and secret-read grants. */
  dataApi?: GurenLambdaDataApiProps
}

/**
 * The full serverless topology in one construct: an HTTP API in front of the
 * `http` handler, opt-in SQS/EventBridge/console wiring, and CloudFront + S3
 * assets. Handler names follow `guren lambda:build` (`handler.http`, ...).
 *
 * @example new GurenLambdaApp(this, 'App', { functionDir: '../.lambda/function' })
 */
export class GurenLambdaApp extends Construct {
  readonly httpFunction: lambda.Function
  readonly httpApi: apigwv2.HttpApi
  readonly queue?: sqs.Queue
  readonly deadLetterQueue?: sqs.Queue
  readonly queueFunction?: lambda.Function
  readonly scheduleFunction?: lambda.Function
  readonly consoleFunction?: lambda.Function
  readonly assetsBucket?: s3.Bucket
  readonly distribution?: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: GurenLambdaAppProps) {
    super(scope, id)

    const code = lambda.Code.fromAsset(props.functionDir)
    const runtime = props.runtime ?? lambda.Runtime.NODEJS_22_X
    const memorySize = props.memorySize ?? 512
    const environment: Record<string, string> = {
      NODE_ENV: 'production',
      ...dataApiEnvironment(props.dataApi),
      // `guren lambda:build` writes the environment the bundle expects (asset
      // and SSR locations) next to the function directory; explicit props win.
      ...readBuildEnvironment(props.functionDir),
      ...props.environment,
    }

    const functionDefaults = { code, runtime, memorySize, environment }

    this.httpFunction = new lambda.Function(this, 'Http', {
      ...functionDefaults,
      handler: lambdaHandlerId('http'),
      timeout: props.timeout ?? Duration.seconds(30),
    })

    this.httpApi = new apigwv2.HttpApi(this, 'Api', {
      defaultIntegration: new HttpLambdaIntegration('HttpIntegration', this.httpFunction),
    })

    if (props.queue) {
      const workerTimeout = props.queue.timeout ?? Duration.seconds(60)

      this.deadLetterQueue = new sqs.Queue(this, 'JobDeadLetterQueue')
      this.queue = new sqs.Queue(this, 'JobQueue', {
        // AWS guidance for Lambda event sources: at least 6x the function
        // timeout, so a message never becomes visible again mid-processing
        // (batching windows and retries extend the in-flight period).
        visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
        deadLetterQueue: {
          queue: this.deadLetterQueue,
          maxReceiveCount: props.queue.maxReceiveCount ?? 3,
        },
      })

      this.queueFunction = new lambda.Function(this, 'QueueWorker', {
        ...functionDefaults,
        handler: lambdaHandlerId('queue'),
        timeout: workerTimeout,
      })

      this.queueFunction.addEventSource(
        new SqsEventSource(this.queue, {
          batchSize: props.queue.batchSize ?? 10,
          // createSqsHandler() returns per-message failures; without this the
          // whole batch would be retried when one job fails.
          reportBatchItemFailures: true,
        }),
      )
    }

    if (props.schedule) {
      this.scheduleFunction = new lambda.Function(this, 'Scheduler', {
        ...functionDefaults,
        handler: lambdaHandlerId('schedule'),
        timeout: Duration.seconds(60),
      })

      new events.Rule(this, 'ScheduleRule', {
        schedule: events.Schedule.rate(props.schedule.rate ?? Duration.minutes(1)),
        targets: [new targets.LambdaFunction(this.scheduleFunction)],
      })
    }

    if (props.console) {
      this.consoleFunction = new lambda.Function(this, 'Console', {
        ...functionDefaults,
        handler: lambdaHandlerId('console'),
        timeout: Duration.minutes(5),
      })
    }

    const functions = [this.httpFunction, this.queueFunction, this.scheduleFunction, this.consoleFunction]
      .filter((fn): fn is lambda.Function => fn !== undefined)

    if (this.queue) {
      // Every function can dispatch jobs (scheduled tasks and console
      // commands included); the SqsDriver reads SQS_QUEUE_URL.
      for (const fn of functions) {
        fn.addEnvironment('SQS_QUEUE_URL', this.queue.queueUrl)
        this.queue.grantSendMessages(fn)
      }
    }

    if (props.dataApi) {
      // The DATABASE_* variables are already in `environment` above, where the
      // spread order gives env.json and explicit props precedence over them.
      for (const fn of functions) {
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: [
            'rds-data:ExecuteStatement',
            'rds-data:BatchExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ],
          resources: [props.dataApi.resourceArn],
        }))
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.dataApi.secretArn],
        }))
      }
    }

    if (props.assets) {
      this.assetsBucket = new s3.Bucket(this, 'Assets', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
      })

      // The API endpoint is https://<id>.execute-api...; CloudFront origins
      // want the bare domain.
      const apiDomain = `${this.httpApi.apiId}.execute-api.${this.httpApi.stack.region}.${this.httpApi.stack.urlSuffix}`
      const assetOrigin = origins.S3BucketOrigin.withOriginAccessControl(this.assetsBucket)
      // One function, shared by every behavior `assetBehavior` is used for.
      const documentGuard = new cloudfront.Function(this, 'AssetDocumentGuard', {
        code: cloudfront.FunctionCode.fromInline(renderAssetDocumentGuard()),
        runtime: cloudfront.FunctionRuntime.JS_2_0,
      })
      const assetBehavior: cloudfront.BehaviorOptions = {
        origin: assetOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        functionAssociations: [
          { function: documentGuard, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      }

      // Both prefixes exist in the staged assets: HTML references /assets/*,
      // built chunks self-reference /public/assets/*.
      const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {
        '/assets/*': assetBehavior,
        '/public/*': assetBehavior,
      }

      // Root-level files copied from public/ (robots.txt, favicon.ico, ...)
      // are unreachable through the default behavior — it points at the app —
      // so each staged root entry gets its own behavior. CloudFront allows 25
      // cache behaviors by default; keep public/ roots small.
      if (existsSync(props.assets.dir)) {
        for (const entry of readdirSync(props.assets.dir, { withFileTypes: true })) {
          if (entry.name === 'assets' || entry.name === 'public') {
            continue
          }
          additionalBehaviors[entry.isDirectory() ? `/${entry.name}/*` : `/${entry.name}`] = assetBehavior
        }
      }

      this.distribution = new cloudfront.Distribution(this, 'Distribution', {
        defaultBehavior: {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          // Every page render is dynamic; assets carry the cacheable content.
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forward cookies/query/headers, but not Host — API Gateway routes
          // by its own hostname.
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
        additionalBehaviors,
      })

      new s3deploy.BucketDeployment(this, 'AssetsDeployment', {
        sources: [s3deploy.Source.asset(props.assets.dir)],
        destinationBucket: this.assetsBucket,
        // Invalidate on deploy: the /public/assets mirror and root-level
        // files are not content-hashed, and CACHING_OPTIMIZED holds them
        // for up to 24h otherwise.
        distribution: this.distribution,
        distributionPaths: ['/*'],
      })

      new CfnOutput(this, 'DistributionUrl', { value: `https://${this.distribution.distributionDomainName}` })
    }

    new CfnOutput(this, 'ApiUrl', { value: this.httpApi.apiEndpoint })
  }
}

/**
 * CloudFront answers asset behaviours from S3 directly, so `guardStaticDocument`
 * never sees these files and an SVG would render inline, script and all. A
 * viewer-response function, not a cache behaviour per extension: those match by
 * path, so `*.svg` would also capture a `/feed.svg` the *app* renders, and the
 * limit of 25 is spent one per staged root entry. Lowercased, so `logo.SVG` too.
 */
function renderAssetDocumentGuard(): string {
  // CloudFront rejects a header a function names in any case but lower.
  const headers = Object.fromEntries(
    Object.entries(DOCUMENT_ASSET_HEADERS).map(([name, value]) => [name.toLowerCase(), value]),
  )

  // Both constants go through JSON.stringify, the one quoting rule that cannot
  // emit a broken function body — a header value carrying an apostrophe would.
  return [
    `var DOCUMENT_EXTENSIONS = ${JSON.stringify(DOCUMENT_ASSET_EXTENSIONS)}`,
    `var DOCUMENT_HEADERS = ${JSON.stringify(headers)}`,
    '',
    ASSET_DOCUMENT_GUARD_BODY,
  ].join('\n')
}

/**
 * The function CloudFront runs, verbatim, reading the two constants
 * {@link renderAssetDocumentGuard} declares above it. Free of interpolation on
 * purpose: a `$` or a backtick in the JavaScript would change how the
 * TypeScript reads, and as written the string is exactly the deployed program.
 */
const ASSET_DOCUMENT_GUARD_BODY = `function handler(event) {
  var uri = event.request.uri
  var response = event.response

  // Decoded first: CloudFront picks the behavior from a normalized path but
  // hands the function the raw one, and S3 resolves percent-encoding when it
  // matches a key. So /evil%2Esvg reaches the object evil.svg while the raw
  // string holds no dot at all — the extension test would find nothing and
  // the document would come back inline. A malformed sequence throws rather
  // than decoding; the raw path is the safe thing to judge in that case,
  // since it is also what no key will match.
  try {
    uri = decodeURIComponent(uri)
  } catch (error) {
    uri = event.request.uri
  }

  var dot = uri.lastIndexOf('.')

  // A dot only ends the last segment when it follows the last slash: without
  // the comparison, /v1.2/app reads as an extension of "2/app".
  if (dot > uri.lastIndexOf('/') && DOCUMENT_EXTENSIONS.indexOf(uri.substring(dot + 1).toLowerCase()) !== -1) {
    for (var name in DOCUMENT_HEADERS) {
      response.headers[name] = { value: DOCUMENT_HEADERS[name] }
    }
  }

  return response
}
`

function dataApiEnvironment(dataApi: GurenLambdaAppProps['dataApi']): Record<string, string> {
  if (!dataApi) {
    return {}
  }

  return {
    DATABASE_RESOURCE_ARN: dataApi.resourceArn,
    DATABASE_SECRET_ARN: dataApi.secretArn,
    ...(dataApi.database ? { DATABASE_NAME: dataApi.database } : {}),
  }
}

function readBuildEnvironment(functionDir: string): Record<string, string> {
  const envPath = resolve(functionDir, '../env.json')
  if (!existsSync(envPath)) {
    return {}
  }

  try {
    return JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}
