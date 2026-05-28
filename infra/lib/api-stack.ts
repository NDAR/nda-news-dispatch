import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import {
  Cors,
  RestApi,
  LambdaIntegration,
  CognitoUserPoolsAuthorizer,
  AuthorizationType,
  EndpointType,
  IResource,
} from 'aws-cdk-lib/aws-apigateway';
import { Runtime, Architecture, Tracing, LoggingFormat } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { CfnScheduleGroup } from 'aws-cdk-lib/aws-scheduler';
import { Role, ServicePrincipal, PolicyStatement, Effect } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';
import { DispatchConfig } from './config';

export interface ApiStackProps extends StackProps {
  config: DispatchConfig;
  userPool: UserPool;
  table: Table;
  archiveBucket: Bucket;
  importsBucket: Bucket;
  sendQueue: Queue;
  enqueueQueue: Queue;
  unsubscribeSecret: Secret;
}

export class ApiStack extends Stack {
  readonly api: RestApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const {
      config,
      userPool,
      table,
      archiveBucket,
      importsBucket,
      sendQueue,
      enqueueQueue,
      unsubscribeSecret,
    } = props;

    const repoRoot = path.resolve(__dirname, '../..');
    const baseFnProps: Partial<NodejsFunctionProps> = {
      runtime: Runtime.NODEJS_20_X,
      architecture: Architecture.ARM_64,
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
    };

    const adminPing = new NodejsFunction(this, 'AdminPingFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/ping.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { ENV_NAME: config.envName },
    });

    const templatesFn = new NodejsFunction(this, 'TemplatesFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/templates.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(15),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        SEND_QUEUE_URL: sendQueue.queueUrl,
      },
    });
    table.grantReadWriteData(templatesFn);
    archiveBucket.grantPut(templatesFn, 'renders/*');
    sendQueue.grantSendMessages(templatesFn);

    const contactsFn = new NodejsFunction(this, 'ContactsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/contacts.ts'),
      handler: 'handler',
      memorySize: 512,
      // 28 s sits just under API Gateway's 29 s integration timeout. The
      // POST /admin/contacts/delete-all route uses most of the budget to
      // drain a CONTACT# partition; the client loops the call until done.
      // Read paths still return in well under a second.
      timeout: Duration.seconds(28),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(contactsFn);

    const importsFn = new NodejsFunction(this, 'ImportsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/imports.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        IMPORTS_BUCKET: importsBucket.bucketName,
      },
    });
    table.grantReadWriteData(importsFn);
    importsBucket.grantPut(importsFn, 'imports/*');
    // Read perms back the import-history "Download CSV" endpoint, which
    // issues presigned GETs for previously-uploaded raw files.
    importsBucket.grantRead(importsFn, 'imports/*');

    const campaignsFn = new NodejsFunction(this, 'CampaignsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/campaigns.ts'),
      handler: 'handler',
      memorySize: 1024,
      timeout: Duration.seconds(30),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        ENQUEUE_QUEUE_URL: enqueueQueue.queueUrl,
      },
    });
    table.grantReadWriteData(campaignsFn);
    enqueueQueue.grantSendMessages(campaignsFn);
    // Scheduled-send wiring is appended below — the schedule group + role +
    // dispatch Lambda are created in the next block so we can't reference
    // them at construction time.

    const typesFn = new NodejsFunction(this, 'TypesFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/types.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(typesFn);

    const settingsFn = new NodejsFunction(this, 'SettingsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/settings.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(settingsFn);

    const suppressionsFn = new NodejsFunction(this, 'SuppressionsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/suppressions.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadWriteData(suppressionsFn);

    const audienceFn = new NodejsFunction(this, 'AudienceFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/audience.ts'),
      handler: 'handler',
      memorySize: 1024,
      timeout: Duration.seconds(30),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
      },
    });
    table.grantReadData(audienceFn);

    const assetsFn = new NodejsFunction(this, 'AssetsFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-admin/src/assets.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        ARCHIVE_BUCKET: archiveBucket.bucketName,
        // Public host fronted by CloudFront — newsletter recipients fetch
        // asset URLs from here.
        PUBLIC_HOST: config.adminHost,
      },
    });
    table.grantReadWriteData(assetsFn);
    archiveBucket.grantPut(assetsFn, 'archive/assets/*');
    archiveBucket.grantDelete(assetsFn, 'archive/assets/*');

    // ── Scheduled-send pipeline (EventBridge Scheduler → worker-dispatch) ──
    // All scheduled campaigns live in a named group so we can list/clean them
    // without touching unrelated schedules. The scheduler-execution role is
    // what EventBridge assumes to invoke the dispatch Lambda; the Lambda
    // itself has the same DDB+SQS perms as the campaigns API handler.
    const scheduleGroup = new CfnScheduleGroup(this, 'CampaignScheduleGroup', {
      name: `dispatch-campaigns-${config.envName}`,
    });

    const dispatchFn = new NodejsFunction(this, 'WorkerDispatchFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/worker-dispatch/src/index.ts'),
      handler: 'handler',
      memorySize: 512,
      timeout: Duration.seconds(30),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        ENQUEUE_QUEUE_URL: enqueueQueue.queueUrl,
        SCHEDULE_GROUP_NAME: scheduleGroup.name!,
      },
    });
    table.grantReadWriteData(dispatchFn);
    enqueueQueue.grantSendMessages(dispatchFn);
    // The worker self-deletes its EventBridge schedule after dispatch.
    dispatchFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['scheduler:DeleteSchedule'],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`,
      ],
    }));

    // EventBridge assumes this role to invoke the dispatch Lambda when a
    // schedule fires. Locked down to the dispatchFn ARN only.
    const schedulerExecRole = new Role(this, 'SchedulerExecRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Used by EventBridge Scheduler to invoke worker-dispatch',
    });
    schedulerExecRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [dispatchFn.functionArn],
    }));

    // Wire the campaigns Lambda to create + delete one-time schedules in
    // the campaign group, passing the scheduler-exec role to EventBridge as
    // the target role. The PassRole is required to nominate that role on
    // CreateSchedule.
    campaignsFn.addEnvironment('SCHEDULE_GROUP_NAME', scheduleGroup.name!);
    campaignsFn.addEnvironment('SCHEDULE_EXEC_ROLE_ARN', schedulerExecRole.roleArn);
    campaignsFn.addEnvironment('DISPATCH_FN_ARN', dispatchFn.functionArn);
    campaignsFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
      resources: [
        `arn:aws:scheduler:${this.region}:${this.account}:schedule/${scheduleGroup.name}/*`,
      ],
    }));
    campaignsFn.addToRolePolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['iam:PassRole'],
      resources: [schedulerExecRole.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'scheduler.amazonaws.com' } },
    }));

    const unsubscribeFn = new NodejsFunction(this, 'UnsubscribeFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-public/src/unsubscribe.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        UNSUB_SECRET: unsubscribeSecret.secretValue.unsafeUnwrap(),
      },
    });
    table.grantReadWriteData(unsubscribeFn);
    unsubscribeSecret.grantRead(unsubscribeFn);

    const viewFn = new NodejsFunction(this, 'ViewFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-public/src/view.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        UNSUB_SECRET: unsubscribeSecret.secretValue.unsafeUnwrap(),
        PUBLIC_BASE_URL: `https://${config.publicHost}`,
      },
    });
    table.grantReadData(viewFn);
    unsubscribeSecret.grantRead(viewFn);

    // Public sign-up flow. Honeypot + optional Cloudflare Turnstile guard
    // POST; confirmation email goes through SES (configuration-set tracked
    // like a regular send so we get bounce/complaint feedback). Set
    // TURNSTILE_SECRET in the Lambda env once you've created a Turnstile
    // site (https://dash.cloudflare.com/?to=/:account/turnstile) — without
    // it the captcha check is bypassed, which is fine for dev but should
    // be set before going public.
    const subscribeFn = new NodejsFunction(this, 'SubscribeFn', {
      ...baseFnProps,
      entry: path.resolve(repoRoot, 'services/api-public/src/subscribe.ts'),
      handler: 'handler',
      memorySize: 384,
      timeout: Duration.seconds(15),
      environment: {
        ENV_NAME: config.envName,
        TABLE_NAME: table.tableName,
        UNSUB_SECRET: unsubscribeSecret.secretValue.unsafeUnwrap(),
        PUBLIC_BASE_URL: `https://${config.publicHost}`,
        FROM_ADDRESS: `Ants Dispatch <dispatch@${config.sendingDomain}>`,
        CONFIG_SET_NAME: `ants-dispatch-${config.envName}`,
        TURNSTILE_SECRET: process.env.TURNSTILE_SECRET ?? '',
      },
    });
    table.grantReadWriteData(subscribeFn);
    unsubscribeSecret.grantRead(subscribeFn);
    subscribeFn.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [
          `arn:aws:ses:${this.region}:${this.account}:identity/*`,
          `arn:aws:ses:${this.region}:${this.account}:configuration-set/ants-dispatch-${config.envName}`,
        ],
        conditions: {
          StringLike: { 'ses:FromAddress': `*@${config.sendingDomain}` },
        },
      }),
    );

    this.api = new RestApi(this, 'DispatchApi', {
      restApiName: `ants-dispatch-api-${config.envName}`,
      deployOptions: {
        stageName: config.envName,
        tracingEnabled: true,
        metricsEnabled: true,
      },
      endpointConfiguration: { types: [EndpointType.REGIONAL] },
      defaultCorsPreflightOptions: {
        allowOrigins: [`https://${config.adminHost}`, 'http://localhost:5173'],
        allowMethods: Cors.ALL_METHODS,
        allowHeaders: ['Authorization', 'Content-Type', 'X-Requested-With'],
        allowCredentials: true,
      },
    });

    const authorizer = new CognitoUserPoolsAuthorizer(this, 'AdminAuthorizer', {
      cognitoUserPools: [userPool],
      identitySource: 'method.request.header.Authorization',
    });
    const authOpts = { authorizer, authorizationType: AuthorizationType.COGNITO };

    const admin = this.api.root.addResource('admin');

    admin.addResource('ping').addMethod('GET', new LambdaIntegration(adminPing), authOpts);

    const templates = admin.addResource('templates');
    templates.addMethod('GET', new LambdaIntegration(templatesFn), authOpts);
    templates.addMethod('POST', new LambdaIntegration(templatesFn), authOpts);
    const templateById: IResource = templates.addResource('{id}');
    templateById.addMethod('GET', new LambdaIntegration(templatesFn), authOpts);
    templateById.addMethod('PUT', new LambdaIntegration(templatesFn), authOpts);
    templateById.addMethod('DELETE', new LambdaIntegration(templatesFn), authOpts);
    const templateTestSend = templateById.addResource('test-send');
    templateTestSend.addMethod('POST', new LambdaIntegration(templatesFn), authOpts);

    const types = admin.addResource('types');
    types.addMethod('GET', new LambdaIntegration(typesFn), authOpts);
    types.addMethod('POST', new LambdaIntegration(typesFn), authOpts);
    const typeById: IResource = types.addResource('{id}');
    typeById.addMethod('GET', new LambdaIntegration(typesFn), authOpts);
    typeById.addMethod('PUT', new LambdaIntegration(typesFn), authOpts);
    typeById.addMethod('DELETE', new LambdaIntegration(typesFn), authOpts);

    const contacts = admin.addResource('contacts');
    contacts.addMethod('GET', new LambdaIntegration(contactsFn), authOpts);
    contacts.addMethod('POST', new LambdaIntegration(contactsFn), authOpts);
    // Iterative bulk-delete. Registered as a separate resource so the
    // method-vs-{email} routing in API Gateway is unambiguous.
    const contactsDeleteAll = contacts.addResource('delete-all');
    contactsDeleteAll.addMethod('POST', new LambdaIntegration(contactsFn), authOpts);
    const contactByEmail: IResource = contacts.addResource('{email}');
    contactByEmail.addMethod('GET', new LambdaIntegration(contactsFn), authOpts);
    contactByEmail.addMethod('PATCH', new LambdaIntegration(contactsFn), authOpts);
    contactByEmail.addMethod('DELETE', new LambdaIntegration(contactsFn), authOpts);

    const imports = admin.addResource('imports');
    imports.addMethod('GET', new LambdaIntegration(importsFn), authOpts);
    imports.addMethod('POST', new LambdaIntegration(importsFn), authOpts);
    const importById: IResource = imports.addResource('{id}');
    importById.addMethod('GET', new LambdaIntegration(importsFn), authOpts);
    // Presigned GET for the original CSV — backs the "Download" button on
    // the import-history view.
    importById.addResource('download').addMethod('GET', new LambdaIntegration(importsFn), authOpts);

    const campaigns = admin.addResource('campaigns');
    campaigns.addMethod('GET', new LambdaIntegration(campaignsFn), authOpts);
    campaigns.addMethod('POST', new LambdaIntegration(campaignsFn), authOpts);
    const campaignById: IResource = campaigns.addResource('{id}');
    campaignById.addMethod('GET', new LambdaIntegration(campaignsFn), authOpts);
    campaignById.addMethod('DELETE', new LambdaIntegration(campaignsFn), authOpts);
    campaignById
      .addResource('send')
      .addMethod('POST', new LambdaIntegration(campaignsFn), authOpts);
    campaignById
      .addResource('cancel')
      .addMethod('POST', new LambdaIntegration(campaignsFn), authOpts);
    campaignById
      .addResource('recipients')
      .addMethod('GET', new LambdaIntegration(campaignsFn), authOpts);
    campaignById
      .addResource('links')
      .addMethod('GET', new LambdaIntegration(campaignsFn), authOpts);

    const tags = admin.addResource('tags');
    tags.addMethod('GET', new LambdaIntegration(audienceFn), authOpts);
    const audience = admin.addResource('audience');
    audience.addResource('preview').addMethod('POST', new LambdaIntegration(audienceFn), authOpts);
    // Lightweight count endpoint backing the TopBar indicator. Uses
    // `Select: 'COUNT'` on the GSI2 status index so it's roughly 5–10×
    // faster than POST /preview for the no-filter case.
    audience.addResource('count').addMethod('GET', new LambdaIntegration(audienceFn), authOpts);

    const assets = admin.addResource('assets');
    assets.addMethod('GET', new LambdaIntegration(assetsFn), authOpts);
    assets.addMethod('POST', new LambdaIntegration(assetsFn), authOpts);
    assets.addResource('{id}').addMethod('DELETE', new LambdaIntegration(assetsFn), authOpts);

    const settings = admin.addResource('settings');
    settings.addMethod('GET', new LambdaIntegration(settingsFn), authOpts);
    settings.addMethod('PUT', new LambdaIntegration(settingsFn), authOpts);

    const suppressions = admin.addResource('suppressions');
    suppressions.addMethod('GET', new LambdaIntegration(suppressionsFn), authOpts);
    suppressions.addMethod('POST', new LambdaIntegration(suppressionsFn), authOpts);
    suppressions
      .addResource('{email}')
      .addMethod('DELETE', new LambdaIntegration(suppressionsFn), authOpts);

    // Public, unauthenticated routes (unsubscribe — open pixel + click redirect
    // are handled by SES's built-in tracking).
    const publicRoot = this.api.root.addResource('public');
    const unsub = publicRoot.addResource('u');
    unsub.addMethod('GET', new LambdaIntegration(unsubscribeFn));
    unsub.addMethod('POST', new LambdaIntegration(unsubscribeFn));
    const view = publicRoot.addResource('v');
    view.addMethod('GET', new LambdaIntegration(viewFn));

    const subscribe = publicRoot.addResource('subscribe');
    subscribe.addMethod('POST', new LambdaIntegration(subscribeFn));
    subscribe.addResource('types').addMethod('GET', new LambdaIntegration(subscribeFn));
    subscribe.addResource('confirm').addMethod('GET', new LambdaIntegration(subscribeFn));

    // WAF — REGIONAL ACL attached to the API stage. Protects both admin and
    // public routes, with an extra rate-limit scoped to /public/* since those
    // endpoints are unauthenticated.
    const webAcl = new CfnWebACL(this, 'ApiWebAcl', {
      name: `ants-dispatch-api-${config.envName}`,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `ants-dispatch-api-${config.envName}`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWSManagedCommon',
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              // The Common rule set's body-inspection rules don't add value
              // for our authenticated admin endpoints (Cognito-protected, and
              // the user is *intentionally* sending HTML newsletter content).
              // libinjection in particular flags ordinary `<body>`/`<h1>` as
              // XSS. Demote each to COUNT so they still appear in metrics
              // but no longer block.
              ruleActionOverrides: [
                { name: 'SizeRestrictions_BODY', actionToUse: { count: {} } },
                { name: 'CrossSiteScripting_BODY', actionToUse: { count: {} } },
                { name: 'GenericLFI_BODY', actionToUse: { count: {} } },
                { name: 'GenericRFI_BODY', actionToUse: { count: {} } },
                { name: 'EC2MetaDataSSRF_BODY', actionToUse: { count: {} } },
              ],
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedCommon',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedBadInputs',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedBadInputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'PublicRateLimit',
          priority: 10,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 300,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: `/${config.envName}/public/`,
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'PublicRateLimit',
            sampledRequestsEnabled: true,
          },
        },
        {
          // Tighter cap on the sign-up endpoint specifically. Honeypot +
          // Turnstile + email confirmation already gate writes, but a
          // 60/5min/IP cap on POST /public/subscribe stops a script from
          // burning through send-confirmation-email cost in a tight loop.
          name: 'SubscribeRateLimit',
          priority: 11,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 60,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: { uriPath: {} },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: `/${config.envName}/public/subscribe`,
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'SubscribeRateLimit',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    new CfnWebACLAssociation(this, 'ApiWebAclAssoc', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    new CfnOutput(this, 'ApiUrl', { value: this.api.url });
    new CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });
  }
}
