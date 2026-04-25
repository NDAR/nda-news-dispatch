import { Construct } from 'constructs';

export type EnvName = 'dev' | 'prod';

export interface DispatchConfig {
  envName: EnvName;
  region: string;
  account?: string;
  rootDomain: string;
  adminHost: string;
  publicHost: string;
  sendingDomain: string;
  mailFromDomain: string;
  removalOnDestroy: boolean;
}

/**
 * Resolves per-deploy configuration. All values come from CDK context, not
 * hard-coded, so the same stacks can be shipped to any account/domain.
 *
 * Required context keys:
 *   env      — 'dev' | 'prod'    (CLI: -c env=dev)
 *   domain   — sending + admin hostname (CLI: -c domain=dispatch.example.com)
 *
 * Optional:
 *   domain.dev / domain.prod  — per-env overrides (in cdk.json context, the
 *     env-specific key wins over a bare `domain`). Lets you commit defaults
 *     per env without needing CLI flags at deploy time.
 *   rootDomain                — explicit parent zone. If unset, inferred by
 *     stripping the first DNS label off `domain` (e.g. dispatch.example.com
 *     → example.com).
 *   region                    — AWS region (defaults to us-east-1).
 *   mailFromSubdomain         — prefix for the custom MAIL-FROM subdomain
 *     (defaults to "mail", yielding mail.<domain>).
 */
export function resolveConfig(scope: Construct): DispatchConfig {
  const ctx = <T = string>(key: string): T | undefined =>
    scope.node.tryGetContext(key) as T | undefined;

  const envRaw = ctx<string>('env') ?? 'dev';
  if (envRaw !== 'dev' && envRaw !== 'prod') {
    throw new Error(`Unknown env "${envRaw}" — pass -c env=dev|prod`);
  }
  const envName = envRaw as EnvName;

  const domain =
    ctx<string>(`domain.${envName}`) ??
    ctx<string>('domain') ??
    process.env.DISPATCH_DOMAIN;
  if (!domain) {
    throw new Error(
      `Missing domain for env "${envName}". Provide one of:\n` +
        `  • CLI flag: -c domain=dispatch.example.com\n` +
        `  • cdk.json context: "domain.${envName}": "dispatch.example.com"\n` +
        `  • Env var: DISPATCH_DOMAIN=dispatch.example.com`,
    );
  }
  assertLooksLikeHostname(domain);

  const rootDomain = ctx<string>('rootDomain') ?? inferRootDomain(domain);
  const region = ctx<string>('region') ?? 'us-east-1';
  const mailFromSubdomain = ctx<string>('mailFromSubdomain') ?? 'mail';

  return {
    envName,
    region,
    account: process.env.CDK_DEFAULT_ACCOUNT,
    rootDomain,
    adminHost: domain,
    publicHost: domain,
    sendingDomain: domain,
    mailFromDomain: `${mailFromSubdomain}.${domain}`,
    removalOnDestroy: envName === 'dev',
  };
}

function inferRootDomain(host: string): string {
  const parts = host.split('.');
  if (parts.length < 2) return host;
  // Strip the first label ("dispatch" from "dispatch.example.com").
  // For a bare apex like "example.com" keep as-is.
  return parts.length === 2 ? host : parts.slice(1).join('.');
}

function assertLooksLikeHostname(v: string): void {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) {
    throw new Error(`domain "${v}" doesn't look like a valid hostname`);
  }
}
