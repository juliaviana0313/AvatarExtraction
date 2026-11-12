import { eq, lt } from 'drizzle-orm';
import { getDb } from '../db';
import { avatarCache } from '../db/schema';
import { edgeAvatarCache, type AvatarCache, type CachedLookup } from './avatar';
export function persistentAvatarCache(origin:string): AvatarCache {
  const edge=edgeAvatarCache(origin);
  return {
    async get(key) {
      const local=await edge.get(key);if(local)return local;
      const db=getDb();
      const rows=await db.select().from(avatarCache).where(eq(avatarCache.key,key)).limit(1);
      if(!rows.length)return undefined;
      if(rows[0].expires<=Date.now()){await db.delete(avatarCache).where(eq(avatarCache.key,key));return undefined;}
      const entry=JSON.parse(rows[0].payload) as CachedLookup;
      await edge.put(key,entry);return entry;
    },
    async put(key,entry) {
      // Persist completed photos only: pending jobs already have signed resume tokens.
      if('avatarUrl' in entry.data) {
        const db=getDb();
        await db.insert(avatarCache).values({key,payload:JSON.stringify(entry),expires:entry.expires}).onConflictDoUpdate({target:avatarCache.key,set:{payload:JSON.stringify(entry),expires:entry.expires}});
        await db.delete(avatarCache).where(lt(avatarCache.expires,Date.now()));
      }
      await edge.put(key,entry);
    },
    async delete(key) {await edge.delete(key);await getDb().delete(avatarCache).where(eq(avatarCache.key,key));}
  };
}
