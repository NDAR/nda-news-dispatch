import { z } from 'zod';

export const Email = z.string().email().transform((s) => s.toLowerCase().trim());

export const TagId = z.string().min(1).max(40).regex(/^[a-z0-9-]+$/);

export const ContactProfile = z.object({
  email: Email,
  name: z.string().min(1).max(200),
  org: z.string().max(200).optional(),
  tags: z.array(TagId).default([]),
  status: z.enum(['active', 'unsubscribed', 'bounced']).default('active'),
  joined: z.string().datetime().optional(),
});
export type ContactProfile = z.infer<typeof ContactProfile>;

export const Template = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  subject: z.string().max(300),
  html: z.string(),
  targetTags: z.array(TagId).default([]),
  updatedAt: z.string().datetime(),
});
export type Template = z.infer<typeof Template>;

export const CampaignStatus = z.enum(['draft', 'scheduled', 'sending', 'sent', 'failed']);

export const Campaign = z.object({
  id: z.string().min(1),
  templateId: z.string().min(1),
  templateVersion: z.number().int().nonnegative(),
  subject: z.string(),
  status: CampaignStatus,
  scheduledFor: z.string().datetime().optional(),
  sentAt: z.string().datetime().optional(),
  recipients: z.number().int().nonnegative().default(0),
  stats: z
    .object({
      delivered: z.number().int().nonnegative(),
      opened: z.number().int().nonnegative(),
      clicked: z.number().int().nonnegative(),
      bounced: z.number().int().nonnegative(),
      unsubscribed: z.number().int().nonnegative(),
    })
    .partial()
    .default({}),
});
export type Campaign = z.infer<typeof Campaign>;
