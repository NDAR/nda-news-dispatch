#!/usr/bin/env node
import 'source-map-support/register';
import { App, Tags } from 'aws-cdk-lib';
import { resolveConfig } from '../lib/config';
import { AuthStack } from '../lib/auth-stack';
import { ApiStack } from '../lib/api-stack';
import { StorageStack } from '../lib/storage-stack';
import { DataStack } from '../lib/data-stack';
import { ProcessingStack } from '../lib/processing-stack';
import { DeliveryStack } from '../lib/delivery-stack';
import { EventsStack } from '../lib/events-stack';
import { EdgeStack } from '../lib/edge-stack';

const app = new App();
const config = resolveConfig(app);
const env = { account: config.account, region: config.region };
const prefix = `NdaDispatch-${config.envName === 'prod' ? 'Prod' : 'Dev'}`;

const auth = new AuthStack(app, `${prefix}-Auth`, { env, config });
const storage = new StorageStack(app, `${prefix}-Storage`, { env, config });
const data = new DataStack(app, `${prefix}-Data`, { env, config });

const processing = new ProcessingStack(app, `${prefix}-Processing`, {
  env,
  config,
  table: data.table,
});

const delivery = new DeliveryStack(app, `${prefix}-Delivery`, {
  env,
  config,
  table: data.table,
  sendQueue: data.sendQueue,
});

new EventsStack(app, `${prefix}-Events`, {
  env,
  config,
  table: data.table,
  eventsTopic: delivery.eventsTopic,
});

const api = new ApiStack(app, `${prefix}-Api`, {
  env,
  config,
  userPool: auth.userPool,
  table: data.table,
  archiveBucket: storage.archiveBucket,
  importsBucket: processing.importsBucket,
  sendQueue: data.sendQueue,
});

new EdgeStack(app, `${prefix}-Edge`, {
  env,
  config,
  spaBucket: storage.spaBucket,
  archiveBucket: storage.archiveBucket,
  api: api.api,
});

Tags.of(app).add('project', 'nda-dispatch');
Tags.of(app).add('env', config.envName);
