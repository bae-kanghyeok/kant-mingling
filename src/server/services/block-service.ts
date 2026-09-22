import "server-only";
import { randomBytes } from "node:crypto";
import type { TxContext } from "../db/tx";
import { reject } from "../http/respond";
import { makeRng } from "../game/rng";
import { createInitialAssignments } from "../game/teams";
import { planRotation, type RotationGroup } from "../game/rotation";
import { DEFAULT_TEAM_SETTINGS, validateRosterConfig, getStudentCapacities, getTeamKeys, type GlobalConfig } from "../game/settings";
import { GameRuleError, type RosterEntry, type TeamAssignment } from "../game/types";
import { ZodError } from "zod";
import { operationLog } from "./shared";

export interface BlockPlan { assignments: TeamAssignment[]; groups: RotationGroup[] }
const rng = (label: string) => makeRng(randomBytes(16).toString("hex"),label);
export async function readRoster(ctx: TxContext): Promise<RosterEntry[]> {
  return (await ctx.client.query<RosterEntry>(`SELECT id,display_name AS "displayName",role,active,roster_order AS "rosterOrder"
    FROM participants WHERE event_id=$1 ORDER BY roster_order`,[ctx.event.id])).rows;
}
export async function readAssignments(ctx: TxContext, block: number): Promise<TeamAssignment[]> {
  return (await ctx.client.query<TeamAssignment>(`SELECT ba.participant_id AS "participantId",t.team_key AS "teamKey",
    CASE WHEN ba.seat_no=0 THEN 'operator' ELSE 'student' END AS role,ba.seat_no AS "seatNo"
    FROM block_assignments ba JOIN teams t ON t.id=ba.team_id WHERE ba.event_id=$1 AND ba.block_no=$2
    ORDER BY t.team_key,ba.seat_no`,[ctx.event.id,block])).rows;
}
export async function effectiveNextRoster(ctx: TxContext) {
  return (ctx.event.pending_roster_json as RosterEntry[]|null) ?? await readRoster(ctx);
}
export async function createSetupDraft(ctx: TxContext) {
  const roster = await effectiveNextRoster(ctx);
  const config = validateRosterConfig(ctx.event.pending_config_json ?? ctx.event.config_json,roster,ctx.event.host_participant_id ?? undefined);
  const assignments = createInitialAssignments({config,roster,rng:rng("initial-teams")});
  await ctx.client.query("UPDATE events SET draft_assignments=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,JSON.stringify(assignments)]);
  return assignments;
}
export async function writeAssignments(ctx: TxContext, block: number, assignments: TeamAssignment[]) {
  const operators = [...new Set(assignments.map(a=>a.teamKey))].sort().map(teamKey=>{
    const operator=assignments.find(a=>a.teamKey===teamKey&&a.role==="operator");
    if(!operator) reject(422,"INVALID_REQUEST");
    return {key:teamKey,id:operator.participantId};
  });
  await ctx.client.query(`WITH saved_teams AS (
    INSERT INTO teams(event_id,team_key,operator_participant_id,settings_json)
    SELECT $1::uuid,p.key,p.id,$3::jsonb FROM jsonb_to_recordset($2::jsonb) AS p(key text,id uuid)
    ON CONFLICT(event_id,team_key) DO UPDATE SET operator_participant_id=excluded.operator_participant_id
    RETURNING id,team_key)
    INSERT INTO block_assignments(event_id,block_no,participant_id,team_id,seat_no)
    SELECT $1::uuid,$4::smallint,a."participantId",t.id,a."seatNo"
    FROM jsonb_to_recordset($5::jsonb) AS a("participantId" uuid,"teamKey" text,"seatNo" smallint)
    JOIN saved_teams t ON t.team_key=a."teamKey"`,
    [ctx.event.id,JSON.stringify(operators),JSON.stringify(DEFAULT_TEAM_SETTINGS),block,JSON.stringify(assignments)]);
}
async function applyPending(ctx: TxContext) {
  const roster = await effectiveNextRoster(ctx);
  const config = validateRosterConfig(ctx.event.pending_config_json ?? ctx.event.config_json,roster,ctx.event.host_participant_id ?? undefined);
  if (ctx.event.pending_roster_json) for(const person of roster) {
    await ctx.client.query(`UPDATE sessions SET revoked_at=$3 WHERE event_id=$1 AND participant_id=$2 AND revoked_at IS NULL
      AND ($4::boolean=false OR EXISTS(SELECT 1 FROM participants p WHERE p.id=$2 AND p.role<>$5))`,
      [ctx.event.id,person.id,ctx.now,person.active!==false,person.role]);
    await ctx.client.query(`UPDATE participants SET display_name=$3,role=$4,active=$5,
      operator_code_hash=CASE WHEN $4='student' THEN NULL ELSE operator_code_hash END WHERE event_id=$1 AND id=$2`,
      [ctx.event.id,person.id,person.displayName,person.role,person.active!==false]);
  }
  await ctx.client.query("UPDATE events SET config_json=$2,pending_config_json=NULL,pending_roster_json=NULL WHERE id=$1",[ctx.event.id,JSON.stringify(config)]);
  ctx.event.config_json=config; ctx.event.pending_config_json=null; ctx.event.pending_roster_json=null;
}
export async function publishSetupDraft(ctx: TxContext) {
  if(ctx.event.phase!=="SETUP" || !Array.isArray(ctx.event.draft_assignments)) reject(409,"WRONG_PHASE");
  await applyPending(ctx);
  await ctx.client.query("DELETE FROM block_assignments WHERE event_id=$1 AND block_no=1",[ctx.event.id]);
  await writeAssignments(ctx,1,ctx.event.draft_assignments as TeamAssignment[]);
  await ctx.client.query("UPDATE events SET teams_published_at=$2,draft_assignments=NULL,session_version=session_version+1 WHERE id=$1",[ctx.event.id,ctx.now]);
}
export async function calculateNextPlan(ctx: TxContext): Promise<BlockPlan> {
  if(ctx.event.current_block<1 || ctx.event.current_block>=3) reject(409,"WRONG_PHASE");
  const roster=await effectiveNextRoster(ctx);
  const config=validateRosterConfig(ctx.event.pending_config_json ?? ctx.event.config_json,roster,ctx.event.host_participant_id ?? undefined);
  const initial=createInitialAssignments({config,roster,rng:rng("target-teams")});
  const pairs=(await ctx.client.query<{aId:string;bId:string;count:number}>(`SELECT a_id AS "aId",b_id AS "bId",count FROM pair_history WHERE event_id=$1`,[ctx.event.id])).rows;
  const current=await readAssignments(ctx,ctx.event.current_block);
  const capacities=getStudentCapacities(config);
  const targetTeams=getTeamKeys(config.teamCount).map((teamKey,i)=>({teamKey,
    operatorId:initial.find(a=>a.teamKey===teamKey&&a.role==="operator")!.participantId,studentCapacity:capacities[i]}));
  const operatorHistory:Record<string,string[]>={};
  for(let b=1;b<=ctx.event.current_block;b++) {
    const previous=await readAssignments(ctx,b);
    for(const student of previous.filter(a=>a.role==="student")) {
      const op=previous.find(a=>a.teamKey===student.teamKey&&a.role==="operator");
      if(op) (operatorHistory[student.participantId]??=[]).push(op.participantId);
    }
  }
  let previousGroups:RotationGroup[]=[];
  if(ctx.event.current_block===2) {
    const first=await readAssignments(ctx,1);
    previousGroups=getTeamKeys(ctx.event.config_json.teamCount).flatMap(teamKey=>{
      const original=first.filter(a=>a.teamKey===teamKey&&a.role==="student");
      return (["stayed","moved"] as const).map(kind=>({teamKey,kind,memberIds:original.filter(a=>
        (current.find(c=>c.participantId===a.participantId)?.teamKey===teamKey)===(kind==="stayed")).map(a=>a.participantId)}));
    });
  }
  const result=planRotation({assignments:current,moveCountPerTeam:config.moveCountPerTeam,nextBlockNo:(ctx.event.current_block+1) as 2|3,
    pairHistory:pairs,previousGroups,operatorHistory,targetTeams,activeStudentIds:roster.filter(p=>p.active!==false&&p.role==="student").map(p=>p.id),rng:rng("rotation")});
  const plan={assignments:result.assignments,groups:result.groups};
  await ctx.client.query("UPDATE events SET next_block_plan=$2 WHERE id=$1",[ctx.event.id,JSON.stringify(plan)]);
  return plan;
}
export async function settleBlocks(ctx: TxContext) {
  if(ctx.event.phase!=="BLOCK") return;
  const blocks=(await ctx.client.query<{phase:string}>("SELECT phase FROM team_blocks WHERE event_id=$1 AND block_no=$2",[ctx.event.id,ctx.event.current_block])).rows;
  if(!blocks.length || blocks.some(b=>b.phase!=="BLOCK_DONE")) return;
  if(ctx.event.current_block===3) return; // Host closes after the final Behind the Data conversation.
  const assignments=await readAssignments(ctx,ctx.event.current_block);
  const pairs: Array<{a:string;b:string}>=[];
  for(const key of [...new Set(assignments.map(a=>a.teamKey))]) {
    const members=assignments.filter(a=>a.teamKey===key);
    for(let i=0;i<members.length;i++) for(let j=i+1;j<members.length;j++) {
      const [a,b]=[members[i].participantId,members[j].participantId].sort();
      pairs.push({a,b});
    }
  }
  await ctx.client.query(`INSERT INTO pair_history(event_id,a_id,b_id,count)
    SELECT $1,p.a::uuid,p.b::uuid,1 FROM jsonb_to_recordset($2::jsonb) AS p(a text,b text)
    ON CONFLICT(event_id,a_id,b_id) DO UPDATE SET count=pair_history.count+1`,[ctx.event.id,JSON.stringify(pairs)]);
  await ctx.client.query("UPDATE events SET phase='BREAK',session_version=session_version+1 WHERE id=$1",[ctx.event.id]);
  ctx.event.phase="BREAK";
  await refreshNextPlan(ctx);
  await operationLog(ctx,"block-complete");
}
export async function refreshNextPlan(ctx:TxContext) {
  try { await calculateNextPlan(ctx); }
  catch(error) {
    // An unfinished settings draft must not roll back the team's last reveal.
    if(!(error instanceof GameRuleError) && !(error instanceof ZodError)) throw error;
    await ctx.client.query("UPDATE events SET next_block_plan=NULL WHERE id=$1",[ctx.event.id]);
    await operationLog(ctx,"rotation-needs-settings");
  }
}
export async function publishNextBlock(ctx: TxContext) {
  if(ctx.event.phase!=="BREAK" || ctx.event.current_block>=3) reject(409,"WRONG_PHASE");
  const plan=ctx.event.next_block_plan as BlockPlan|null;
  if(!plan?.assignments?.length) reject(409,"WRONG_PHASE");
  await applyPending(ctx);
  const block=ctx.event.current_block+1;
  await writeAssignments(ctx,block,plan.assignments);
  await ctx.client.query(`INSERT INTO team_blocks(event_id,block_no,team_id,phase,settings_json)
    SELECT DISTINCT $1::uuid,$2::smallint,t.id,'SEATING',t.settings_json FROM teams t JOIN block_assignments ba ON ba.team_id=t.id
    WHERE ba.event_id=$1 AND ba.block_no=$2`,[ctx.event.id,block]);
  await ctx.client.query("UPDATE events SET phase='BLOCK',current_block=$2,next_block_plan=NULL,session_version=session_version+1 WHERE id=$1",[ctx.event.id,block]);
}
export async function createFirstTeamBlocks(ctx: TxContext) {
  if(ctx.event.phase!=="SETUP" || !ctx.event.teams_published_at) reject(409,"WRONG_PHASE");
  await ctx.client.query(`INSERT INTO team_blocks(event_id,block_no,team_id,phase,settings_json,started_at)
    SELECT DISTINCT $1::uuid,1,t.id,'SEATING',t.settings_json,$2::timestamptz FROM teams t JOIN block_assignments ba ON ba.team_id=t.id
    WHERE ba.event_id=$1 AND ba.block_no=1`,[ctx.event.id,ctx.now]);
  await ctx.client.query("UPDATE participants SET profile_locked_at=$2 WHERE event_id=$1 AND profile_completed_at IS NOT NULL",[ctx.event.id,ctx.now]);
  await ctx.client.query("UPDATE events SET phase='BLOCK',current_block=1,started_at=$2,session_version=session_version+1 WHERE id=$1",[ctx.event.id,ctx.now]);
  ctx.event.phase="BLOCK"; ctx.event.current_block=1;
  return (await ctx.client.query<{id:string}>("SELECT id FROM team_blocks WHERE event_id=$1 AND block_no=1 ORDER BY team_id",[ctx.event.id])).rows;
}
export async function saveGlobalDraft(ctx: TxContext, settings: GlobalConfig) {
  validateRosterConfig(settings,await effectiveNextRoster(ctx),ctx.event.host_participant_id ?? undefined);
  await ctx.client.query("UPDATE events SET pending_config_json=$2,draft_assignments=NULL,next_block_plan=NULL,session_version=session_version+1 WHERE id=$1",[ctx.event.id,JSON.stringify(settings)]);
  ctx.event.pending_config_json=settings;
  if(ctx.event.phase==="SETUP") {
    await ctx.client.query("DELETE FROM block_assignments WHERE event_id=$1 AND block_no=1",[ctx.event.id]);
    await ctx.client.query("UPDATE events SET teams_published_at=NULL WHERE id=$1",[ctx.event.id]);
    ctx.event.teams_published_at=null;
  }
  if(ctx.event.phase==="BREAK") await calculateNextPlan(ctx);
}
