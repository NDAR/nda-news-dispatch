import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Runtime, Architecture, Tracing, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import {
  CfnConfigurationSet,
  CfnConfigurationSetEventDestination,
  CfnEmailIdentity,
} from 'aws-cdk-lib/aws-ses';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { DispatchConfig } from './config';

export interface DeliveryStackProps extends StackProps {
  config: DispatchConfig;
  table: Table;
  sendQueue: Queue;
}

/**
 * SES delivery surface + send worker.
 *
 * Topology:
 *   SES Domain Identity (dispatch.scienthouse.io)    ← DKIM + MAIL-FROM
 *        └─ attached to ConfigurationSet
 *                 └─ EventDestination → SNS "ses-events"
 *                         (step 7 will subscribe the events ingestor Lambda)
 *
 *   sendQueue (DataStack)  ──▶  worker-send Lambda  ──▶  SES:SendEmail
 *                                     │
 *                                     └─ updates CAMPAIGN#<id> RCPT#<email>
 *
 * The domain identity is created in "pending verification" state — it becomes
 * sendable once DNS is set up (DKIM CNAMEs + _amazonses TXT). Until then the
 * worker will fail SES:SendEmail with MessageRejected, which is fine for
 * architecture testing.
 */
export class DeliveryStack extends Stack {
  readonly sesIdentity: CfnEmailIdentity;
  readonly configSet: CfnConfigurationSet;
  readonly eventsTopic: Topic;
  readonly workerSend: NodejsFunction;
  readonly fromAddress: string;

  constructor(scope: Construct, id: string, props: DeliveryStackProps) {
    super(scope, id, props);
    const { config, table, sendQueue } = props;
    const repoRoot = path.resolve(__dirname, '../..');
    const sendingDomain = config.sendingDomain;
    const publicBaseUrl = `https://${config.publicHost}`;
    this.fromAddress = `NDA Dispatch <dispatch@${sendingDomain}>`;

    this.configSet = new CfnConfigurationSet(this, 'ConfigSet', {
      name: `nda-dispatch-${config.envName}`,
      reputationOptions: { reputationMetricsEnabled: true },
      sendingOptions: { sendingEnabled: true },
    });

    this.sesIdentity = new CfnEmailIdentity(this, 'DomainIdentity', {
      emailIdentity: sendingDomain,
      configurationSetAttributes: { configurationSetName: this.configSet.name! },
      dkimAttributes: { signingEnabled: true },
      mailFromAttributes: {
        mailFromDomain: config.mailFromDomain,
        behaviorOnMxFailure: 'USE_DEFAULT_VALUE',
      },
    });
    this.sesIdentity.addDependency(this.configSet);

    this.eventsTopic = new Topic(this, 'SesEventsTopic', {
      topicName: `nda-dispatch-${config.envName}-ses-events`,
      displayName: 'NDA Dispatch — SES events',
    });

    new CfnConfigurationSetEventDestination(this, 'SesEventsDest', {
      configurationSetName: this.configSet.name!,
      eventDestination: {
        name: 'sns-events',
        enabled: true,
        matchingEventTypes: [
          'send',
          'reject',
          'bounce',
          'complaint',
          'delivery',
          'open',
          'click',
          'renderingFailure',
          'deliveryDelay',
          'subscription',
        ],
        snsDestination: { topicArn: this.eventsTopic.topicArn },
      },
    });

    this.workerSend = new NodejsFunction(this, 'WorkerSendFn', {
      entry: path.resolve(repoRoot, 'services/worker-send/src/index.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
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
        CONFIG_SET_NAME: this.configSet.name!,
        FROM_ADDRESS: this.fromAddress,
        PUBLIC_BASE_URL: publicBaseUrl,
      },
    });

    table.grantReadWriteData(this.workerSend);
    this.workerSend.addEventSource(
      new SqsEventSource(sendQueue, {
        batchSize: 10,
        maxBatchingWindow: Duration.seconds(2),
        reportBatchItemFailures: true,
      }),
    );

    // ses:SendEmail / ses:SendRawEmail for the configuration set. Scoped to
    // this identity ARN so the worker can't send from other verified
    // identities in the account.
    this.workerSend.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/${sendingDomain}`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/${this.configSet.name}`,
        ],
      }),
    );

    new CfnOutput(this, 'SendingDomain', { value: sendingDomain });
    new CfnOutput(this, 'ConfigSetName', { value: this.configSet.name! });
    new CfnOutput(this, 'SesEventsTopicArn', { value: this.eventsTopic.topicArn });
    new CfnOutput(this, 'WorkerSendFnName', { value: this.workerSend.functionName });
    new CfnOutput(this, 'FromAddress', { value: this.fromAddress });
  }
}
