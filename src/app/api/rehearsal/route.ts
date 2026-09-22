import { z } from "zod";
import { assertRehearsalDeployment, assertRehearsalOrigin } from "@/server/rehearsal/guards";
import { rehearsalCommand, rehearsalState } from "@/server/rehearsal/service";
import { readJson } from "@/server/http/origin";
import { CommandRejected, errorResponse, json } from "@/server/http/respond";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  try {
    const slug = new URL(request.url).searchParams.get("slug") ?? "";
    assertRehearsalDeployment(slug); assertRehearsalOrigin(request);
    return json(await rehearsalState(request, slug));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertRehearsalOrigin(request);
    return await rehearsalCommand(request, await readJson(request));
  } catch (error) {
    return errorResponse(error instanceof z.ZodError ? new CommandRejected(422, "INVALID_REQUEST") : error);
  }
}
