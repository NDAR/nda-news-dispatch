import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import {
  Bucket,
  BucketEncryption,
  BlockPublicAccess,
  ObjectOwnership,
  HttpMethods,
} from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { DispatchConfig } from './config';

export interface StorageStackProps extends StackProps {
  config: DispatchConfig;
}

/**
 * Buckets only. CloudFront + ACM live in EdgeStack because the distribution
 * also fronts API Gateway (owned by ApiStack), so it depends on both.
 */
export class StorageStack extends Stack {
  readonly spaBucket: Bucket;
  readonly archiveBucket: Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);
    const { config } = props;
    const removalPolicy = config.removalOnDestroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const autoDelete = config.removalOnDestroy;

    const baseBucketProps = {
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: true,
      removalPolicy,
      autoDeleteObjects: autoDelete,
    };

    this.spaBucket = new Bucket(this, 'SpaBucket', {
      ...baseBucketProps,
      bucketName: `nda-dispatch-spa-${config.envName}-${this.account}`,
    });

    this.archiveBucket = new Bucket(this, 'ArchiveBucket', {
      ...baseBucketProps,
      bucketName: `nda-dispatch-archive-${config.envName}-${this.account}`,
      // Allow the SPA to PUT directly to a presigned URL when uploading
      // newsletter assets. GET/HEAD are also allowed so a future "preview
      // before insert" flow can fetch the just-uploaded image without going
      // through CloudFront's cache.
      cors: [
        {
          allowedMethods: [HttpMethods.PUT, HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    });

    new CfnOutput(this, 'SpaBucketName', { value: this.spaBucket.bucketName });
    new CfnOutput(this, 'ArchiveBucketName', { value: this.archiveBucket.bucketName });
  }
}
