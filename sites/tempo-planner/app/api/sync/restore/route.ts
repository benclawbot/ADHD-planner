import { apiErrorResponse, handleSyncRequest } from "../../../../lib/sync-api";
import { getSharedKeyDigest, getSyncRepository } from "../../../../lib/sync-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return await handleSyncRequest(request, getSyncRepository, getSharedKeyDigest());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
