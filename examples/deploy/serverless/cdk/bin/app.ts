/**
 * CDK app for a Guren application on AWS Lambda.
 *
 * Copy this `cdk/` directory next to your app root, run
 * `bunx guren lambda:build` in the app, then `bunx cdk deploy` here.
 */
import { App, Stack } from 'aws-cdk-lib'
import { GurenLambdaApp } from '@guren/plugin-lambda/cdk'

const app = new App()

const stack = new Stack(app, 'GurenApp', {
  // Pin the account/region instead of relying on ambient credentials:
  // env: { account: '123456789012', region: 'ap-northeast-1' },
})

new GurenLambdaApp(stack, 'App', {
  // Output of `guren lambda:build`, relative to this cdk/ directory.
  functionDir: '../.lambda/function',

  // Serve public/ from S3 behind CloudFront; the app is the default origin,
  // so the CloudFront URL is the one to put in front of users.
  assets: { dir: '../.lambda/assets' },

  // SQS queue + worker with a dead-letter queue and partial batch failures.
  // Every function receives SQS_QUEUE_URL and permission to send.
  // Remove if the app dispatches no jobs.
  queue: {},

  // Console function: run CLI commands in the deployed environment, e.g.
  //   aws lambda invoke --function-name ... \
  //     --cli-binary-format raw-in-base64-out \
  //     --payload '{"command":"db:migrate"}' out.json
  console: true,

  // EventBridge rule invoking the `schedule` export every minute.
  // Enable once src/lambda.ts exports a schedule handler.
  // schedule: {},

  // Wires DATABASE_* environment variables plus the rds-data and
  // secret-read IAM grants onto every function, so the console function
  // can run migrations and the app can query Aurora out of the box.
  dataApi: {
    database: process.env.DATABASE_NAME!,
    resourceArn: process.env.DATABASE_RESOURCE_ARN!,
    secretArn: process.env.DATABASE_SECRET_ARN!,
  },

  environment: {
    APP_KEY: process.env.APP_KEY!,
  },
})

// Every sub-resource is exposed as a property (httpFunction, queue,
// distribution, ...) for further wiring — custom domains, extra IAM, or
// per-function memory overrides.
