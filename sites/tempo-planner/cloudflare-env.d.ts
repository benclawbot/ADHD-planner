declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    TEMPO_SHARED_KEY_SHA256?: string;
  }
}
