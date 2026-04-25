import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import {
  Distribution,
  ViewerProtocolPolicy,
  AllowedMethods,
  CachedMethods,
  CachePolicy,
  ResponseHeadersPolicy,
  PriceClass,
  SecurityPolicyProtocol,
  HttpVersion,
  OriginRequestPolicy,
  FunctionEventType,
  Function as CfFunction,
  FunctionCode,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin, RestApiOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Bucket, CfnBucketPolicy } from 'aws-cdk-lib/aws-s3';
import { RestApi } from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';
import { DispatchConfig } from './config';

export interface EdgeStackProps extends StackProps {
  config: DispatchConfig;
  spaBucket: Bucket;
  archiveBucket: Bucket;
  api: RestApi;
}

/**
 * Single-origin fronting for the whole app:
 *   /                         → SPA (S3, OAC), SPA-route fallback to index.html
 *   /archive/*, /renders/*    → Archive bucket (S3, OAC)
 *   /admin/*, /public/*       → API Gateway (RestApiOrigin handles stage path)
 *
 * ACM cert is created here in us-east-1 with DNS validation. The stack will
 * block in CREATE_IN_PROGRESS until the validation CNAME (printed in the
 * event log and available via `aws acm describe-certificate`) is published.
 */
export class EdgeStack extends Stack {
  readonly distribution: Distribution;
  readonly certificate: Certificate;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { config, spaBucket, archiveBucket, api } = props;
    const host = config.adminHost;

    this.certificate = new Certificate(this, 'Cert', {
      domainName: host,
      validation: CertificateValidation.fromDns(),
    });

    const spaRewrite = new CfFunction(this, 'SpaRewriteFn', {
      runtime: FunctionRuntime.JS_2_0,
      comment: 'Rewrite SPA routes to /index.html',
      code: FunctionCode.fromInline(`
        function handler(event) {
          var req = event.request;
          var uri = req.uri;
          if (uri === '' || uri === '/') { req.uri = '/index.html'; return req; }
          if (uri.indexOf('.') === -1) { req.uri = '/index.html'; }
          return req;
        }
      `),
    });

    const securityHeaders = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      responseHeadersPolicyName: `nda-dispatch-security-${config.envName}`,
      securityHeadersBehavior: {
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          preload: true,
          override: true,
        },
        xssProtection: { protection: true, modeBlock: true, override: true },
      },
    });

    // Re-import the buckets inside THIS stack so that
    // S3BucketOrigin.withOriginAccessControl's bucket.addToResourcePolicy call
    // no-ops (imported buckets have no autoCreatePolicy). Otherwise CDK would
    // add a BucketPolicy to the bucket's owning stack (StorageStack)
    // referencing this distribution's ARN, creating a Storage→Edge dep cycle
    // (EdgeStack already reads bucket ARNs → Edge→Storage).
    const spaRef = Bucket.fromBucketAttributes(this, 'SpaBucketRef', {
      bucketName: spaBucket.bucketName,
      bucketArn: spaBucket.bucketArn,
      region: this.region,
    });
    const archiveRef = Bucket.fromBucketAttributes(this, 'ArchiveBucketRef', {
      bucketName: archiveBucket.bucketName,
      bucketArn: archiveBucket.bucketArn,
      region: this.region,
    });
    const spaOrigin = S3BucketOrigin.withOriginAccessControl(spaRef);
    const archiveOrigin = S3BucketOrigin.withOriginAccessControl(archiveRef);
    const apiOrigin = new RestApiOrigin(api);

    // NOTE: no `errorResponses` here. CloudFront-level custom error responses
    // apply to every origin including API Gateway, which means a 403 from a
    // misrouted PUT (or a 4xx from any admin/public route) gets silently
    // rewritten into a 200 + index.html, breaking API calls. SPA deep-links
    // (`/compose`, `/history`, etc.) are already handled by the
    // CloudFront-Function viewer-request rewrite, so the fallback is unneeded.

    this.distribution = new Distribution(this, 'Cdn', {
      comment: `nda-dispatch edge (${config.envName})`,
      priceClass: PriceClass.PRICE_CLASS_100,
      httpVersion: HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultRootObject: 'index.html',
      domainNames: [host],
      certificate: this.certificate,
      defaultBehavior: {
        origin: spaOrigin,
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: OriginRequestPolicy.CORS_S3_ORIGIN,
        responseHeadersPolicy: securityHeaders,
        compress: true,
        functionAssociations: [{ function: spaRewrite, eventType: FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/archive/*': {
          origin: archiveOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
        '/renders/*': {
          origin: archiveOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
        '/admin/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
        '/public/*': {
          origin: apiOrigin,
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          compress: true,
        },
      },
    });

    // OAC bucket policies attached in THIS stack (not Storage), so the
    // distribution ARN reference stays Edge→Edge.
    const distributionArn = `arn:aws:cloudfront::${this.account}:distribution/${this.distribution.distributionId}`;
    const oacStatement = (bucketArn: string) => ({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: 's3:GetObject',
          Resource: `${bucketArn}/*`,
          Condition: { StringEquals: { 'AWS:SourceArn': distributionArn } },
        },
      ],
    });

    new CfnBucketPolicy(this, 'SpaBucketPolicy', {
      bucket: spaBucket.bucketName,
      policyDocument: oacStatement(spaBucket.bucketArn),
    });
    new CfnBucketPolicy(this, 'ArchiveBucketPolicy', {
      bucket: archiveBucket.bucketName,
      policyDocument: oacStatement(archiveBucket.bucketArn),
    });

    new CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
    new CfnOutput(this, 'DistributionDomain', { value: this.distribution.distributionDomainName });
    new CfnOutput(this, 'PublicUrl', { value: `https://${host}` });
    new CfnOutput(this, 'CertificateArn', { value: this.certificate.certificateArn });
  }
}
