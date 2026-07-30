---
'@guren/plugin-lambda': minor
'@guren/cli': patch
---

Add the `GurenLambdaApp` CDK construct under `@guren/plugin-lambda/cdk`.

One construct provisions the full serverless topology for a Guren app: an
HTTP API in front of the `http` handler, an SQS queue + worker with a
dead-letter queue and partial batch failures, an EventBridge rule for the
scheduler, a console function for CLI commands, CloudFront + S3 serving
the staged assets (including per-file behaviors for root-level public files),
and a `dataApi` option that wires the DATABASE_* environment and IAM grants
for Aurora's RDS Data API onto every function. `aws-cdk-lib` and
`constructs` are optional peer dependencies. The `guren deploy` error message
now points AWS Lambda users at the plugin.
