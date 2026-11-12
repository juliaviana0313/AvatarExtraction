declare namespace Cloudflare {
  interface Env {
    APISH_API_KEY?: string;
    APIFY_API_KEY?: string;
    BRIGHTDATA_API_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
