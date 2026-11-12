import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const avatarCache = sqliteTable('avatar_cache', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  expires: integer('expires').notNull(),
});

export const avatarJobs = sqliteTable('avatar_jobs', {
  id: text('id').primaryKey(),
  cacheKey: text('cache_key').notNull(),
  activeKey: text('active_key').unique(),
  profileUrl: text('profile_url').notNull(),
  origin: text('origin').notNull(),
  status: text('status').notNull(),
  storageAllowed: integer('storage_allowed').notNull().default(0),
  snapshot: text('snapshot'),
  result: text('result'),
  error: text('error'),
  createdAt: integer('created_at').notNull(),
  submittedAt: integer('submitted_at'),
  readyAt: integer('ready_at'),
  completedAt: integer('completed_at'),
  nextCheck: integer('next_check').notNull().default(0),
  leaseUntil: integer('lease_until').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  submissionMs: integer('submission_ms'),
  scrapingMs: integer('scraping_ms'),
  retrievalMs: integer('retrieval_ms'),
  storageMs: integer('storage_ms'),
  imageLoadMs: integer('image_load_ms'),
  cacheHit: integer('cache_hit').notNull().default(0),
});
