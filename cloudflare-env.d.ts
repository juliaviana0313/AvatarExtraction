declare namespace Cloudflare {
  interface Env {
    BRIGHTDATA_API_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
