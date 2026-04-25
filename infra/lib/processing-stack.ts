import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import { Runtime, Architecture, Tracing, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  Bucket,
  BucketEncryption,
  BlockPublicAccess,
  ObjectOwnership,
  HttpMethods,
  LifecycleRule,
  EventType,
} from 'aws-cdk-lib/aws-s3';
import { SqsDestination } from 'aws-cdk-lib/aws-s3-notifications';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import * as path from 'path';
import { DispatchConfig } from './config';

export interface ProcessingStackProps extends StackProps {
  config: DispatchConfig;
  table: Table;
}

/**
 * Owns the CSV-import pipeline end-to-end so all cross-refs flow one way:
 *   importsBucket  ── S3:ObjectCreated(imports/*.csv) ─▶ importQueue
 *                                                         │
 *                                                         ▼
 *                                                Lambda worker-import
 *                                                → parse, suppress-check,
 *                                                  upsert contacts,
 *                                                  update IMPORT record
 *
 * Kept in one stack (bucket + queue + notification) to avoid the bucket↔queue
 * cross-stack cycle that arises when the bucket's notification resource (in
 * StorageStack) has to reference a queue ARN (in DataStack) while the queue
 * policy has to grant s3:SendMessage from the bucket ARN.
 */
export class ProcessingStack extends Stack {
  readonly importsBucket: Bucket;
  readonly importQueue: Queue;
  readonly importDlq: Queue;
  readonly workerImport: NodejsFunction;

  constructor(scope: Construct, id: string, props: ProcessingStackProps) {
    super(scope, id, props);
    const { config, table } = props;
    const repoRoot = path.resolve(__dirname, '../..');
    const removalPolicy = config.removalOnDestroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const autoDelete = config.removalOnDestroy;

    const importLifecycle: LifecycleRule[] = [
      {
        id: 'expire-raw-imports',
        prefix: 'imports/',
        expiration: Duration.days(30),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      },
    ];

    this.importsBucket = new Bucket(this, 'ImportsBucket', {
      bucketName: `nda-dispatch-imports-${config.envName}-${this.account}`,
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: autoDelete,
      lifecycleRules: importLifecycle,
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: [`https://${config.adminHost}`, 'http://localhost:5173'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    this.importDlq = new Queue(this, 'ImportDlq', {
      queueName: `nda-dispatch-${config.envName}-import-dlq`,
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
    });

    this.importQueue = new Queue(this, 'ImportQueue', {
      queueName: `nda-dispatch-${config.envName}-import`,
      encryption: QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(120),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { maxReceiveCount: 5, queue: this.importDlq },
    });

    this.importsBucket.addEventNotification(
      EventType.OBJECT_CREATED,
      new SqsDestination(this.importQueue),
      { prefix: 'imports/', suffix: '.csv' },
    );

    this.workerImport = new NodejsFunction(this, 'WorkerImportFn', {
      entry: path.resolve(repoRoot, 'services/worker-import/src/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 1024,
      timeout: Duration.minutes(2),
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

    table.grantReadWriteData(this.workerImport);
    this.importsBucket.grantRead(this.workerImport, 'imports/*');

    this.workerImport.addEventSource(
      new SqsEventSource(this.importQueue, {
        batchSize: 1,
        reportBatchItemFailures: true,
      }),
    );

    new CfnOutput(this, 'ImportsBucketName', { value: this.importsBucket.bucketName });
    new CfnOutput(this, 'ImportQueueUrl', { value: this.importQueue.queueUrl });
    new CfnOutput(this, 'WorkerImportFnName', { value: this.workerImport.functionName });
  }
}
