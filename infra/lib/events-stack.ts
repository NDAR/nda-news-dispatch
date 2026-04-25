import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Runtime, Architecture, Tracing, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import * as path from 'path';
import { DispatchConfig } from './config';

export interface EventsStackProps extends StackProps {
  config: DispatchConfig;
  table: Table;
  eventsTopic: Topic;
}

/**
 * SNS "ses-events" → worker-events Lambda → Dynamo stats + suppressions.
 * A DLQ on the subscription catches any message the handler can't process
 * after Lambda's own retries — otherwise SES events would be silently dropped.
 */
export class EventsStack extends Stack {
  readonly workerEvents: NodejsFunction;
  readonly ingestDlq: Queue;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);
    const { config, table, eventsTopic } = props;
    const repoRoot = path.resolve(__dirname, '../..');

    this.ingestDlq = new Queue(this, 'IngestDlq', {
      queueName: `nda-dispatch-${config.envName}-events-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });

    this.workerEvents = new NodejsFunction(this, 'WorkerEventsFn', {
      entry: path.resolve(repoRoot, 'services/worker-events/src/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(20),
      tracing: Tracing.ACTIVE,
      logRetention: RetentionDays.ONE_MONTH,
      loggingFormat: LoggingFormat.JSON,
      depsLockFilePath: path.resolve(repoRoot, 'package-lock.json'),
      projectRoot: repoRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: 'node20',
        externalModules: ['@aws-sdk/*'],
      },
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });

    table.grantReadWriteData(this.workerEvents);

    eventsTopic.addSubscription(
      new LambdaSubscription(this.workerEvents, {
        deadLetterQueue: this.ingestDlq,
      }),
    );

    new CfnOutput(this, 'WorkerEventsFnName', { value: this.workerEvents.functionName });
    new CfnOutput(this, 'IngestDlqUrl', { value: this.ingestDlq.queueUrl });
  }
}
