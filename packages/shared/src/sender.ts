/**
 * Sender identity resolution. Used by both the API (at send time, to
 * snapshot the resolved values onto the CAMPAIGN META row) and any caller
 * that needs to render or display the effective From / Reply-To.
 *
 * Resolution rules: each field is independently overridden — a type can
 * set just `fromLocalPart` and inherit the rest. Legacy defaults preserve
 * pre-feature behavior for workspaces that never touch the new fields.
 */

export interface SenderOverrides {
  fromName?: string;
  fromLocalPart?: string;
  replyTo?: string;
}

export interface ResolvedSender {
  /** RFC 5322 mailbox: `Display Name <local@domain>`. Suitable for direct
   *  use as `SendEmailCommand.FromEmailAddress`. */
  fromEmail: string;
  /** Bare address. Omitted when no override or default is set — caller
   *  should also omit the `Reply-To:` header in that case. */
  replyTo?: string;
}

/** Mirrors the historical FROM_ADDRESS env value
 *  (`Ants Dispatch <dispatch@<sendingDomain>>`) so workspaces that never
 *  configure the new fields keep getting the same outbound headers. */
export const DEFAULT_FROM_NAME = 'Ants Dispatch';
export const DEFAULT_FROM_LOCAL_PART = 'dispatch';

export const FROM_LOCAL_PART_RE = /^[a-z0-9._-]{1,64}$/;
export const FROM_NAME_MAX = 120;
export const REPLY_TO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function resolveSender(
  orgDefaults: SenderOverrides,
  typeOverrides: SenderOverrides | undefined,
  sendingDomain: string,
): ResolvedSender {
  const fromName = pick(typeOverrides?.fromName, orgDefaults.fromName, DEFAULT_FROM_NAME);
  const fromLocalPart = pick(
    typeOverrides?.fromLocalPart,
    orgDefaults.fromLocalPart,
    DEFAULT_FROM_LOCAL_PART,
  );
  const replyTo = pick(typeOverrides?.replyTo, orgDefaults.replyTo, undefined);
  return {
    fromEmail: `${formatDisplayName(fromName)} <${fromLocalPart}@${sendingDomain}>`,
    replyTo,
  };
}

/** RFC 5322: a display name containing any of the listed specials must be
 *  encoded as a quoted-string. Plain ASCII names without specials pass
 *  through unquoted, matching the legacy `Ants Dispatch <…>` shape. */
function formatDisplayName(name: string): string {
  if (/[(),:;<>@\\"\[\]]/.test(name)) {
    return `"${name.replace(/(["\\])/g, '\\$1')}"`;
  }
  return name;
}

function pick<T>(typeVal: T | undefined, orgVal: T | undefined, fallback: T): T {
  if (typeVal !== undefined && typeVal !== null && typeVal !== '') return typeVal;
  if (orgVal !== undefined && orgVal !== null && orgVal !== '') return orgVal;
  return fallback;
}
