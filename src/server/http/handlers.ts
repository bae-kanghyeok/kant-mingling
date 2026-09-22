import "server-only";
import { z } from "zod";
import { readJson } from "./origin";
import { CommandRejected, errorResponse, json, reject } from "./respond";
import { getRequestTokenHash, hashSessionToken, sessionCookieHeader } from "../auth/session";
import { bootstrapSession, claimParticipant, authenticateOperator, releaseParticipant } from "../services/registration";
import { saveProfileAnswer, submitProfile } from "../services/profile";
import { runCommand, type CommandResult } from "../db/tx";
import { getState } from "../dto/state-dto";
import { executeAdminCommand } from "../services/admin-service";
import { executeGameCommand } from "../services/game-service";
import { settleBlocks } from "../services/block-service";
import { GameRuleError } from "../game/types";

const slugSchema=z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const uuid=z.uuid();
function commandResponse<T>(result:CommandResult<T>) {
  if(!result.ok) return errorResponse(new CommandRejected(result.status,result.code));
  return json({ok:true,...(result.data??{})});
}
export function apiHandler(action:string) {
  return async function handle(request:Request):Promise<Response> {
    try {
      if(action==="state") {
        const slug=slugSchema.parse(new URL(request.url).searchParams.get("slug"));
        const tokenHash=getRequestTokenHash(request); if(!tokenHash) reject(401,"UNAUTHENTICATED");
        return json(await getState(slug,tokenHash));
      }
      const body=await readJson(request);
      const slug=slugSchema.parse(body.slug);
      const tokenHash=getRequestTokenHash(request);
      if(action==="bootstrap") {
        const ip=process.env.VERCEL==="1"?(request.headers.get("x-vercel-forwarded-for")??request.headers.get("x-forwarded-for")??"unknown"):"local";
        const session=await bootstrapSession({slug,tokenHash,ipHash:hashSessionToken(`ip:${ip.split(",")[0].trim()}`)});
        return json({ok:true},200,session.token?{"Set-Cookie":sessionCookieHeader(session.token,session.maxAgeSeconds)}:undefined);
      }
      if(!tokenHash) reject(401,"UNAUTHENTICATED");
      const receipt=!(["profile","sync","ensemble-vote","intro-ack"].includes(action));
      const requestId=receipt?uuid.parse(body.requestId):undefined;
      const serviceRequest={slug,tokenHash,requestId};
      if(action==="claim") return commandResponse(await claimParticipant(serviceRequest,uuid.parse(body.participantId)));
      if(action==="operator") return commandResponse(await authenticateOperator(serviceRequest,{participantId:uuid.parse(body.participantId),code:z.string().min(1).max(128).parse(body.code)}));
      if(action==="release") return commandResponse(await releaseParticipant(serviceRequest));
      if(action==="profile") return commandResponse(await saveProfileAnswer(serviceRequest,z.object({questionId:z.string(),option:z.enum(["A","B"]),revision:z.number().int().nonnegative()}).parse(body)));
      if(action==="profile-submit") return commandResponse(await submitProfile(serviceRequest));
      return commandResponse(await runCommand({...serviceRequest,command:action,payload:body,receipt},async ctx=>{
        if(action==="sync") return {};
        if(ctx.event.phase==="ENDED") reject(410,"ENDED");
        let result:Record<string,unknown>;
        try {
          if(action==="admin") result=await executeAdminCommand(ctx,z.object({command:z.string(),teamKey:z.string().max(3).optional(),expectedVersion:z.number().int().nonnegative().optional(),args:z.record(z.string(),z.unknown()).optional()}).parse(body));
          else result=await executeGameCommand(ctx,action,body);
          if(action!=="intro-ack" && action!=="ensemble-vote") await settleBlocks(ctx);
        } catch(error) {
          if(error instanceof z.ZodError) reject(422,"INVALID_REQUEST");
          if(error instanceof GameRuleError) reject(422,error.code);
          throw error;
        }
        return result;
      }));
    } catch(error) {
      if(error instanceof z.ZodError) return errorResponse(new CommandRejected(422,"INVALID_REQUEST"));
      return errorResponse(error);
    }
  };
}
