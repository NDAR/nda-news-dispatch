import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPreviewSrcDoc } from '../web/src/lib/previewFrame.ts';
import {
  contactStatusIndexFields,
  suppressionState,
  toAudienceProfile,
} from '../packages/shared/src/contact-model.ts';
import {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../packages/shared/src/unsubscribe.ts';

test('preview builder injects CSP and base href', () => {
  const doc = buildPreviewSrcDoc('<p>Hello</p>', { baseHref: 'https://cdn.example.test/assets/' });

  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /script-src 'none'/);
  assert.match(doc, /<base href="https:\/\/cdn\.example\.test\/assets\/">/);
  assert.match(doc, /<body><p>Hello<\/p><\/body>/);
});

test('preview builder escapes base href attributes', () => {
  const doc = buildPreviewSrcDoc('<html><head></head><body>x</body></html>', {
    baseHref: 'https://cdn.example.test/?q="><script>alert(1)</script>',
  });

  assert.doesNotMatch(doc, /<script>alert\(1\)<\/script>/);
  assert.match(doc, /&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('unsubscribe tokens verify only for the matching campaign and recipient', () => {
  const secret = 'super-secret-key';
  const token = createUnsubscribeToken(secret, 'campaign-123', 'user@example.com');

  assert.equal(verifyUnsubscribeToken(secret, 'campaign-123', 'user@example.com', token), true);
  assert.equal(verifyUnsubscribeToken(secret, 'campaign-456', 'user@example.com', token), false);
  assert.equal(verifyUnsubscribeToken(secret, 'campaign-123', 'other@example.com', token), false);
  assert.equal(verifyUnsubscribeToken('wrong-secret', 'campaign-123', 'user@example.com', token), false);
});

test('contact status index and suppression helpers produce consistent profile state', () => {
  assert.deepEqual(contactStatusIndexFields('user@example.com', 'active'), {
    GSI2PK: 'CONTACTSTATUS#active',
    GSI2SK: 'CONTACT#user@example.com',
  });

  assert.deepEqual(suppressionState(), { suppressed: false });
  assert.deepEqual(suppressionState('unsubscribe', '2026-04-26T00:00:00.000Z'), {
    suppressed: true,
    suppressedAt: '2026-04-26T00:00:00.000Z',
    suppressionReason: 'unsubscribe',
  });

  assert.deepEqual(
    toAudienceProfile({
      email: 'user@example.com',
      name: 'User',
      org: 'Example Org',
      tags: ['alpha', 'beta'],
      status: 'active',
      suppressed: false,
    }),
    {
      email: 'user@example.com',
      name: 'User',
      org: 'Example Org',
      tags: ['alpha', 'beta'],
      status: 'active',
      suppressed: false,
      suppressedAt: undefined,
      suppressionReason: undefined,
    },
  );
});
