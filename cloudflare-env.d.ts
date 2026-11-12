declare namespace Cloudflare {
  interface Env {
    APIFY_API_KEY?: string;
    BRIGHTDATA_API_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
