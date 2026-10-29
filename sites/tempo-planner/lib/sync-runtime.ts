import { env } from "cloudflare:workers";
import { D1SyncRepository } from "./d1-sync-repository";

export function getSyncRepository(): D1SyncRepository {
  if (!env.DB) throw new Error("D1 binding DB is unavailable. Check .openai/hosting.json and apply the generated migration.");
  return new D1SyncRepository(env.DB as never);
}

export function getSharedKeyDigest(): string | undefined {
  return env.TEMPO_SHARED_KEY_SHA256;
}
