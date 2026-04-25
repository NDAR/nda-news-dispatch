# DynamoDB single-table layout

Table: `nda-dispatch-<env>` — PAY_PER_REQUEST, PITR on, stream `NEW_AND_OLD_IMAGES`, `ttl` attribute.
GSI1: `GSI1PK` / `GSI1SK`, projection ALL.

## Item shapes

| Entity | PK | SK | GSI1PK / GSI1SK | Attributes |
|---|---|---|---|---|
| Template version | `TEMPLATE#<id>` | `v<zero-padded>` | — | id, version, title, subject, html, targetTags[], updatedAt, updatedBy |
| Template latest pointer | `TEMPLATE#<id>` | `LATEST` | `TEMPLATE#latest` / `<id>` | same as version + deleted? |
| Contact profile | `CONTACT#<email>` | `PROFILE` | — | email, name, org, tags[], status, joined |
| Contact tag index | `CONTACT#<email>` | `TAG#<tag>` | `TAG#<tag>` / `CONTACT#<email>` | email |
| Suppression | `SUPP#<email>` | `REASON#<reason>` | — | email, reason, at, source (ses\|manual\|unsub) |
| Campaign meta | `CAMPAIGN#<id>` | `META` | `STATUS#<status>` / `<createdAt>` | id, name, templateId, templateVersion, subject, html, status, tags[], excludeTags[], tagMode, recipients, createdAt/By, sentAt/By |
| Campaign recipient | `CAMPAIGN#<id>` | `RCPT#<email>` | `RCPT#<email>` / `<id>` | email, state (pending\|sent\|bounced\|opened\|clicked), queuedAt, sentAt, messageId |
| Campaign stats | `CAMPAIGN#<id>` | `STATS` | — | delivered, opened, clicked, bounced, complained, unsubscribed (updated via ADD) |
| Import job | `IMPORT#<id>` | `META` | `IMPORT#all` / `<createdAt>` | importId, key, filename, assignTag?, status, counts{total,inserted,updated,suppressed,invalid}, createdAt, createdBy |

## Access patterns

1. **List templates** — `Query GSI1 where GSI1PK=TEMPLATE#latest`.
2. **Get template (latest)** — `GetItem PK=TEMPLATE#<id>, SK=LATEST`.
3. **Get template version history** — `Query PK=TEMPLATE#<id> AND begins_with(SK, 'v')`.
4. **Contacts by tag** — `Query GSI1 where GSI1PK=TAG#<tag>`, then batch-get profiles.
5. **Is email suppressed?** — `Query PK=SUPP#<email>` (any result = yes).
6. **History by status / time** — `Query GSI1 where GSI1PK=STATUS#sent, SK descending`.
7. **Campaign drill-down** — `GetItem PK=CAMPAIGN#<id>, SK=STATS` + `Query PK=CAMPAIGN#<id> AND begins_with(SK, 'RCPT#')` for per-recipient state.

## Notes

- Writes of template versions + LATEST pointer are two `PutItem`s issued concurrently — eventually consistent; SPA fetches LATEST which is authoritative. Renders are also pushed to S3 at `renders/<id>/v<version>.html` for preview.
- Stats are incremented by the SES-event ingestor using `ADD`.
- TTL is used for ephemeral records only (e.g. unsubscribe tokens); primary data is retained.
