import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TxContext } from "../db/tx";
import { reject } from "../http/respond";
import { parseGlobalConfig, parseTeamSettings, applyPreset, DEFAULT_TEAM_SETTINGS } from "../game/settings";
import { swapAssignmentSeats } from "../game/teams";
import type { RosterEntry, TeamAssignment } from "../game/types";
import { createGame, forceReveal } from "./game-service";
import { requireHost, controlledTeam, currentTeamBlock, checkVersion, operationLog } from "./shared";
import { createSetupDraft, publishSetupDraft, createFirstTeamBlocks, publishNextBlock, saveGlobalDraft,
  calculateNextPlan, refreshNextPlan, effectiveNextRoster, type BlockPlan } from "./block-service";

const uuid=z.uuid();
const hostCommands=new Set(["assign-teams","publish-teams","start-game1","publish-next-block","end-session","transfer-host",
  "update-global-settings","swap-seats","upsert-participant","remove-participant"]);
export const adminCommands=[...hostCommands,"unlock-participant","mark-attendance","next-game","start-block-game","pause","resume",
  "force-end-game","transfer-turn-lead","resend-data","update-team-settings","apply-preset"];

async function targetParticipant(ctx:TxContext,id:string) {
  const target=(await ctx.client.query<{id:string;profile_locked_at:Date|null;role:string}>(
    "SELECT id,profile_locked_at,role FROM participants WHERE event_id=$1 AND id=$2 FOR UPDATE",[ctx.event.id,id])).rows[0];
  if(!target) reject(404,"NOT_FOUND");
  if(ctx.session.role!=="operator") reject(403,"FORBIDDEN");
  if(ctx.session.participant_id!==ctx.event.host_participant_id && ctx.event.teams_published_at) {
    const assignment=(await ctx.client.query<{operator_participant_id:string}>(`SELECT t.operator_participant_id FROM block_assignments ba JOIN teams t ON t.id=ba.team_id
      WHERE ba.event_id=$1 AND ba.participant_id=$2 AND ba.block_no=$3`,[ctx.event.id,id,Math.max(1,ctx.event.current_block)])).rows[0];
    if(assignment?.operator_participant_id!==ctx.session.participant_id) reject(403,"FORBIDDEN");
  }
  return target;
}
async function rosterChange(ctx:TxContext,command:string,args:Record<string,unknown>) {
  if(ctx.event.current_block===3) reject(409,"WRONG_PHASE");
  let roster=await effectiveNextRoster(ctx);
  let targetId:string;
  if(command==="remove-participant") {
    targetId=uuid.parse(args.participantId);
    if(targetId===ctx.event.host_participant_id) reject(422,"HOST_REPLACEMENT_REQUIRED");
    if(!roster.some(p=>p.id===targetId)) reject(404,"NOT_FOUND");
    roster=roster.map(p=>p.id===targetId?{...p,active:false}:p);
  } else {
    const input=z.object({participantId:uuid.optional(),displayName:z.string().trim().min(1).max(40),role:z.enum(["student","operator"])}).parse(args);
    targetId=input.participantId??randomUUID();
    if(roster.some(p=>p.id!==targetId&&p.displayName===input.displayName)) reject(422,"DUPLICATE_NAME");
    if(targetId===ctx.event.host_participant_id&&input.role!=="operator") reject(422,"HOST_REPLACEMENT_REQUIRED");
    const existing=roster.find(p=>p.id===targetId);
    if(input.participantId&&!existing) reject(404,"NOT_FOUND");
    const person:RosterEntry={id:targetId,displayName:input.displayName,role:input.role,active:true,
      rosterOrder:existing?.rosterOrder??Math.max(0,...roster.map(p=>p.rosterOrder))+1};
    if(existing) roster=roster.map(p=>p.id===targetId?person:p);
    else {
      roster.push(person);
      await ctx.client.query("INSERT INTO participants(id,event_id,display_name,role,roster_order,active) VALUES($1,$2,$3,$4,$5,false)",
        [person.id,ctx.event.id,person.displayName,person.role,person.rosterOrder]);
    }
    // Preserve an explicit operator seat when that operator is renamed.
    const config=structuredClone(ctx.event.pending_config_json??ctx.event.config_json);
    if(existing&&config.operatorTeamByName[existing.displayName]) {
      const key=config.operatorTeamByName[existing.displayName]; delete config.operatorTeamByName[existing.displayName];
      if(input.role==="operator") config.operatorTeamByName[input.displayName]=key;
      ctx.event.pending_config_json=config;
    }
  }
  const config=structuredClone(ctx.event.pending_config_json??ctx.event.config_json);
  const names=new Set(roster.filter(p=>p.active!==false&&p.role==="operator").map(p=>p.displayName));
  config.operatorTeamByName=Object.fromEntries(Object.entries(config.operatorTeamByName).filter(([name])=>names.has(name)));
  config.studentCount=roster.filter(p=>p.active!==false&&p.role==="student").length;
  if(ctx.event.phase==="SETUP") {
    for(const person of roster) {
      await ctx.client.query(`UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND participant_id=$2 AND revoked_at IS NULL
        AND ($4::boolean=false OR EXISTS(SELECT 1 FROM participants p WHERE p.id=$2 AND p.role<>$5))`,
        [ctx.event.id,person.id,ctx.now,person.active!==false,person.role]);
      await ctx.client.query(`UPDATE participants SET display_name=$3,role=$4,active=$5,
      operator_code_hash=CASE WHEN $4='student' THEN NULL ELSE operator_code_hash END WHERE event_id=$1 AND id=$2`,
      [ctx.event.id,person.id,person.displayName,person.role,person.active!==false]);
    }
    await ctx.client.query("DELETE FROM block_assignments WHERE event_id=$1 AND block_no=1",[ctx.event.id]);
    await ctx.client.query("UPDATE events SET config_json=$2,pending_roster_json=NULL,pending_config_json=NULL,draft_assignments=NULL,teams_published_at=NULL,session_version=session_version+1 WHERE id=$1",[ctx.event.id,JSON.stringify(config)]);
  } else {
    await ctx.client.query("UPDATE events SET pending_roster_json=$2,pending_config_json=$3,next_block_plan=NULL,session_version=session_version+1 WHERE id=$1",
      [ctx.event.id,JSON.stringify(roster),JSON.stringify(config)]);
    ctx.event.pending_roster_json=roster;ctx.event.pending_config_json=config;
    if(ctx.event.phase==="BREAK") await refreshNextPlan(ctx);
  }
  await operationLog(ctx,command,targetId);
  return {};
}

export async function executeAdminCommand(ctx:TxContext,input:{command:string;teamKey?:string;expectedVersion?:number;args?:Record<string,unknown>}) {
  const {command,teamKey}=input; const args=input.args??{};
  if(!adminCommands.includes(command)) reject(422,"INVALID_REQUEST");
  if(ctx.session.role!=="operator") reject(403,"FORBIDDEN");
  if(ctx.event.phase==="ENDED") reject(410,"ENDED");
  if(hostCommands.has(command)) {
    requireHost(ctx); checkVersion(ctx.event.session_version,input.expectedVersion);
    if(command==="assign-teams") { if(ctx.event.phase!=="SETUP") reject(409,"WRONG_PHASE"); await createSetupDraft(ctx); }
    else if(command==="publish-teams") await publishSetupDraft(ctx);
    else if(command==="start-game1") {
      const missing=(await ctx.client.query("SELECT id FROM participants WHERE event_id=$1 AND role='operator' AND active AND profile_completed_at IS NULL",[ctx.event.id])).rowCount;
      if(missing&&args.force!==true) reject(409,"OPERATORS_INCOMPLETE");
      const blocks=await createFirstTeamBlocks(ctx);
      if(!blocks?.length) reject(409,"WRONG_PHASE");
      for(const block of blocks) await createGame(ctx,{teamBlockId:block.id,gameNo:1});
    }
    else if(command==="publish-next-block") await publishNextBlock(ctx);
    else if(command==="update-global-settings") await saveGlobalDraft(ctx,parseGlobalConfig(args.settings));
    else if(command==="swap-seats") {
      const a=uuid.parse(args.a),b=uuid.parse(args.b);
      if(ctx.event.phase==="SETUP"&&Array.isArray(ctx.event.draft_assignments)) {
        const swapped=swapAssignmentSeats(ctx.event.draft_assignments as TeamAssignment[],a,b);
        await ctx.client.query("UPDATE events SET draft_assignments=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,JSON.stringify(swapped)]);
      } else if(ctx.event.phase==="BREAK"&&ctx.event.next_block_plan) {
        const plan=ctx.event.next_block_plan as BlockPlan;
        const assignments=swapAssignmentSeats(plan.assignments,a,b);
        await ctx.client.query("UPDATE events SET next_block_plan=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,JSON.stringify({...plan,assignments})]);
      } else reject(409,"WRONG_PHASE");
    }
    else if(command==="upsert-participant"||command==="remove-participant") return rosterChange(ctx,command,args);
    else if(command==="transfer-host") {
      const target=uuid.parse(args.participantId);
      const participant=(await ctx.client.query("SELECT id FROM participants WHERE event_id=$1 AND id=$2 AND active AND role='operator'",[ctx.event.id,target])).rows[0];
      if(!participant) reject(422,"INVALID_REQUEST");
      await ctx.client.query("UPDATE events SET host_participant_id=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,target]);
    }
    else if(command==="end-session") {
      if(args.confirm!==true) reject(422,"CONFIRM_REQUIRED");
      if(ctx.event.current_block!==3&&(args.emergency!==true||args.confirmEmergency!==true)) reject(409,"WRONG_PHASE");
      const active=(await ctx.client.query<{id:string}>("SELECT id FROM games WHERE event_id=$1 AND phase<>'REVEALED' ORDER BY team_id",[ctx.event.id])).rows;
      for(const game of active) await forceReveal(ctx,game.id,"session_end");
      await ctx.client.query("UPDATE events SET phase='ENDED',ended_at=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,ctx.now]);
    }
    await operationLog(ctx,command); return {};
  }
  if(command==="unlock-participant"||command==="mark-attendance") {
    const participantId=uuid.parse(args.participantId); const target=await targetParticipant(ctx,participantId);
    if(command==="unlock-participant") {
      if(args.resetAnswers===true) {
        if(target.profile_locked_at||ctx.event.phase!=="SETUP") reject(409,"PROFILE_LOCKED");
        await ctx.client.query("DELETE FROM profile_answers WHERE participant_id=$1",[participantId]);
        await ctx.client.query("UPDATE participants SET profile_completed_at=NULL WHERE id=$1",[participantId]);
      }
      await ctx.client.query("UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND participant_id=$2 AND revoked_at IS NULL",[ctx.event.id,participantId,ctx.now]);
    } else {
      const attendance=z.enum(["present","absent","unknown"]).parse(args.attendance);
      await ctx.client.query("UPDATE participants SET attendance=$2 WHERE id=$1",[participantId,attendance]);
    }
    await operationLog(ctx,command,participantId); return {};
  }
  if(!teamKey) reject(422,"INVALID_REQUEST");
  const team=await controlledTeam(ctx,teamKey);
  if(command==="update-team-settings"||command==="apply-preset") {
    const result=await ctx.client.query<{id:string;team_version:number;settings_json:unknown}>("SELECT id,team_version,settings_json FROM team_blocks WHERE event_id=$1 AND team_id=$2 AND block_no=$3 FOR UPDATE",[ctx.event.id,team.id,ctx.event.current_block]);
    const block=result.rows[0]; checkVersion(block?.team_version??ctx.event.session_version,input.expectedVersion);
    const current=parseTeamSettings(Object.keys(block?.settings_json??team.settings_json??{}).length?(block?.settings_json??team.settings_json):DEFAULT_TEAM_SETTINGS);
    const settings=command==="apply-preset"?applyPreset(current,z.enum(["easy","normal","hard"]).parse(args.preset)):
      parseTeamSettings({...z.record(z.string(),z.unknown()).parse(args.settings),preset:"custom"});
    await ctx.client.query("UPDATE teams SET settings_json=$2 WHERE id=$1",[team.id,JSON.stringify(settings)]);
    if(block) await ctx.client.query("UPDATE team_blocks SET settings_json=$2,team_version=team_version+1 WHERE id=$1",[block.id,JSON.stringify(settings)]);
    else await ctx.client.query("UPDATE events SET session_version=session_version+1 WHERE id=$1",[ctx.event.id]);
    await operationLog(ctx,command,teamKey); return {};
  }
  const block=await currentTeamBlock(ctx,team.id);
  if(command==="next-game"||command==="start-block-game") {
    checkVersion(block.team_version,input.expectedVersion);
    if(block.paused_at) reject(409,"PAUSED");
    let gameNo=(ctx.event.current_block-1)*3+1;
    if(command==="next-game") {
      if(block.phase!=="REVEAL"||!block.current_game_id) reject(409,"WRONG_PHASE");
      gameNo=(await ctx.client.query<{game_no:number}>("SELECT game_no FROM games WHERE id=$1",[block.current_game_id])).rows[0].game_no+1;
      if((gameNo-1)%3===0) reject(409,"WRONG_PHASE");
    } else if(block.phase!=="SEATING") reject(409,"WRONG_PHASE");
    await createGame(ctx,{teamBlockId:block.id,gameNo});
  } else {
    if(block.phase!=="IN_GAME"||!block.current_game_id) reject(409,"WRONG_PHASE");
    const game=(await ctx.client.query<{id:string;phase:string;game_version:number;vote_deadline:Date|null;vote_remaining_ms:number|null}>("SELECT id,phase,game_version,vote_deadline,vote_remaining_ms FROM games WHERE id=$1 FOR UPDATE",[block.current_game_id])).rows[0];
    if(command==="transfer-turn-lead"||command==="resend-data") {
      checkVersion(game.game_version,input.expectedVersion);
      if(!["TURN","ENSEMBLE_SHARE"].includes(game.phase)) reject(409,"WRONG_PHASE");
      const participantId=uuid.parse(args.participantId);
      if(!(await ctx.client.query("SELECT 1 FROM game_members WHERE game_id=$1 AND participant_id=$2",[game.id,participantId])).rowCount) reject(422,"INVALID_REQUEST");
      if(command==="resend-data") {
        const cardNo=z.number().int().min(1).max(20).parse(args.cardNo);
        const card=(await ctx.client.query<{id:string}>("SELECT id FROM data_cards WHERE game_id=$1 AND card_no=$2",[game.id,cardNo])).rows[0];
        if(!card) reject(422,"INVALID_REQUEST");
        if((await ctx.client.query("SELECT 1 FROM card_deliveries WHERE card_id=$1 AND participant_id=$2",[card.id,participantId])).rowCount) reject(409,"ALREADY_DELIVERED");
        await ctx.client.query("INSERT INTO card_deliveries(card_id,participant_id,reason) VALUES($1,$2,'resend')",[card.id,participantId]);
        if(game.phase==="ENSEMBLE_SHARE") await ctx.client.query("UPDATE games SET ensemble_sharer_id=$2 WHERE id=$1",[game.id,participantId]);
      }
      await ctx.client.query("UPDATE games SET turn_lead_participant_id=$2,game_version=game_version+1 WHERE id=$1",[game.id,participantId]);
    } else {
      checkVersion(block.team_version,input.expectedVersion);
      if(command==="force-end-game") await forceReveal(ctx,game.id,"forced");
      else if(command==="pause") {
        if(block.paused_at) reject(409,"PAUSED");
        const remaining=game.vote_deadline?Math.max(0,new Date(game.vote_deadline).getTime()-ctx.now.getTime()):null;
        await ctx.client.query("UPDATE games SET vote_remaining_ms=$2,vote_deadline=NULL,game_version=game_version+1 WHERE id=$1",[game.id,remaining]);
        await ctx.client.query("UPDATE team_blocks SET paused_at=$2,team_version=team_version+1 WHERE id=$1",[block.id,ctx.now]);
      } else if(command==="resume") {
        if(!block.paused_at) reject(409,"WRONG_PHASE");
        const elapsed=ctx.now.getTime()-new Date(block.paused_at).getTime();
        const deadline=game.phase==="ENSEMBLE_VOTE"?new Date(ctx.now.getTime()+(game.vote_remaining_ms??0)):null;
        await ctx.client.query("UPDATE games SET paused_ms_total=paused_ms_total+$2,vote_deadline=$3,vote_remaining_ms=NULL,game_version=game_version+1 WHERE id=$1",[game.id,elapsed,deadline]);
        await ctx.client.query("UPDATE team_blocks SET paused_at=NULL,team_version=team_version+1 WHERE id=$1",[block.id]);
      } else reject(422,"INVALID_REQUEST");
    }
  }
  await operationLog(ctx,command,teamKey); return {};
}

export async function refreshPendingPlan(ctx:TxContext) {
  if(ctx.event.phase==="BREAK") await calculateNextPlan(ctx);
}
