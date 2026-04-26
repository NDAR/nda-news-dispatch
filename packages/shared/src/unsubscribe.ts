import { createHmac, timingSafeEqual } from 'node:crypto';

export function createUnsubscribeToken(secret: string, campaignId: string, email: string): string {
  return createHmac('sha256', secret).update(`${campaignId}|${email}`).digest('base64url');
}

export function verifyUnsubscribeToken(
  secret: string,
  campaignId: string,
  email: string,
  token: string,
): boolean {
  const expected = createUnsubscribeToken(secret, campaignId, email);
  const actualBuf = Buffer.from(token, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  if (actualBuf.length !== expectedBuf.length) return false;
  try {
    return timingSafeEqual(actualBuf, expectedBuf);
  } catch {
    return false;
  }
}
