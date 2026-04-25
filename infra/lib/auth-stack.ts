import { Stack, StackProps, Duration, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import {
  UserPool,
  UserPoolClient,
  AccountRecovery,
  Mfa,
  OAuthScope,
  UserPoolDomain,
  AdvancedSecurityMode,
} from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { DispatchConfig } from './config';

export interface AuthStackProps extends StackProps {
  config: DispatchConfig;
}

export class AuthStack extends Stack {
  readonly userPool: UserPool;
  readonly userPoolClient: UserPoolClient;
  readonly userPoolDomain: UserPoolDomain;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.userPool = new UserPool(this, 'AdminPool', {
      userPoolName: `nda-dispatch-admins-${config.envName}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: false },
        givenName: { required: false, mutable: true },
        familyName: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: Duration.days(3),
      },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      advancedSecurityMode: AdvancedSecurityMode.AUDIT,
      removalPolicy: config.removalOnDestroy ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
    });

    const spaOrigin = `https://${config.adminHost}`;
    const localDev = 'http://localhost:5173';

    this.userPoolClient = this.userPool.addClient('AdminSpa', {
      userPoolClientName: `admin-spa-${config.envName}`,
      generateSecret: false,
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(14),
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: [`${spaOrigin}/auth/callback`, `${localDev}/auth/callback`],
        logoutUrls: [`${spaOrigin}/`, `${localDev}/`],
      },
    });

    this.userPoolDomain = this.userPool.addDomain('HostedUi', {
      cognitoDomain: {
        domainPrefix: `nda-dispatch-${config.envName}-${this.account.slice(-4)}`,
      },
    });

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, 'HostedUiDomain', {
      value: `${this.userPoolDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
    new CfnOutput(this, 'Issuer', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}`,
    });
  }
}
