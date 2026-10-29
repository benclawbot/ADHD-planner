import { apiErrorResponse, handleSessionRequest } from "../../../lib/sync-api";
import { getSharedKeyDigest } from "../../../lib/sync-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await handleSessionRequest(request, getSharedKeyDigest());
  } catch (error) {
    return apiErrorResponse(error);
  }
}
