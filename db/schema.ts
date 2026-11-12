import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const avatarCache = sqliteTable('avatar_cache', {
  key: text('key').primaryKey(),
  payload: text('payload').notNull(),
  expires: integer('expires').notNull(),
});
