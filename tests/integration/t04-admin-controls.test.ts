import { randomUUID } from "node:crypto";
import { afterAll,afterEach,beforeEach,expect,it } from "vitest";
import { closePool,getPool } from "@/server/db/pool";
import { runCommand } from "@/server/db/tx";
import { executeAdminCommand } from "@/server/services/admin-service";
import { settleBlocks } from "@/server/services/block-service";
import { DEFAULT_GLOBAL_CONFIG } from "@/server/game/settings";
import { createTestEvent,createTestSession,cleanupTestEvent,type TestEvent,type TestSession } from "./helpers";
let event:TestEvent; let host:TestSession;
beforeEach(async()=>{event=await createTestEvent();host=await createTestSession(event,event.operators[0]);});
afterEach(async()=>{if(event)await cleanupTestEvent(event);}); afterAll(closePool);
async function command(session:TestSession,name:string,args:Record<string,unknown>={},teamKey?:string,requestId=randomUUID()) {
  const version=(await getPool().query<{session_version:number}>("SELECT session_version FROM events WHERE id=$1",[event.id])).rows[0].session_version;
  const body={command:name,args,teamKey,expectedVersion:version};
  return runCommand({slug:event.slug,tokenHash:session.tokenHash,command:"admin",payload:body,requestId,receipt:true},ctx=>executeAdminCommand(ctx,body));
}
it("T04 rejects student/non-host global commands and another team's unlock",async()=>{
  const student=await createTestSession(event,event.students[0]);
  const otherOperator=await createTestSession(event,event.operators[1]);
  expect(await command(student,"assign-teams")).toMatchObject({ok:false,status:403});
  expect(await command(otherOperator,"assign-teams")).toMatchObject({ok:false,status:403});
  expect(await command(host,"assign-teams")).toMatchObject({ok:true});
  expect(await command(host,"publish-teams")).toMatchObject({ok:true});
  const person=(await getPool().query<{participant_id:string}>(`SELECT ba.participant_id FROM block_assignments ba JOIN teams t ON t.id=ba.team_id
    WHERE ba.event_id=$1 AND t.team_key='A' AND ba.seat_no>0 LIMIT 1`,[event.id])).rows[0].participant_id;
  expect(await command(otherOperator,"unlock-participant",{participantId:person})).toMatchObject({ok:false,status:403});
  expect(await command(host,"unlock-participant",{participantId:person})).toMatchObject({ok:true});
});
it("T27 repeated publish uses a receipt and changed payload with the same ID is rejected",async()=>{
  await command(host,"assign-teams");
  const requestId=randomUUID();
  const version=(await getPool().query<{session_version:number}>("SELECT session_version FROM events WHERE id=$1",[event.id])).rows[0].session_version;
  const body={command:"publish-teams",expectedVersion:version,args:{}};
  const req={slug:event.slug,tokenHash:host.tokenHash,command:"admin",payload:body,requestId,receipt:true};
  const both=await Promise.all([runCommand(req,ctx=>executeAdminCommand(ctx,body)),runCommand(req,ctx=>executeAdminCommand(ctx,body))]);
  expect(both.every(r=>r.ok)).toBe(true);
  expect((await getPool().query("SELECT count(*)::integer n FROM block_assignments WHERE event_id=$1",[event.id])).rows[0].n).toBe(21);
  expect(await runCommand({...req,payload:{...body,args:{changed:true}}},ctx=>executeAdminCommand(ctx,body))).toMatchObject({ok:false,code:"REQUEST_ID_REUSED"});
});
it("T06 approved minimum cannot be bypassed by force-start and partial game creation rolls back",async()=>{
  await command(host,"assign-teams"); await command(host,"publish-teams");
  expect(await command(host,"start-game1",{force:true})).toMatchObject({ok:false,code:"INSUFFICIENT_MEMBERS"});
  expect((await getPool().query("SELECT phase FROM events WHERE id=$1",[event.id])).rows[0].phase).toBe("SETUP");
  expect((await getPool().query("SELECT count(*)::integer n FROM games WHERE event_id=$1",[event.id])).rows[0].n).toBe(0);
});
it("T22 global SETUP edits invalidate already published seats before a new start",async()=>{
  await command(host,"assign-teams"); await command(host,"publish-teams");
  const config={...DEFAULT_GLOBAL_CONFIG,operatorTeamByName:{운영진A:"A",운영진B:"B",운영진C:"C"},moveCountPerTeam:2};
  expect(await command(host,"update-global-settings",{settings:config})).toMatchObject({ok:true});
  expect((await getPool().query("SELECT teams_published_at FROM events WHERE id=$1",[event.id])).rows[0].teams_published_at).toBeNull();
  expect(await command(host,"start-game1",{force:true})).toMatchObject({ok:false,code:"WRONG_PHASE"});
  expect(await command(host,"assign-teams")).toMatchObject({ok:true});
  expect(await command(host,"publish-teams")).toMatchObject({ok:true});
  expect((await getPool().query("SELECT config_json FROM events WHERE id=$1",[event.id])).rows[0].config_json.moveCountPerTeam).toBe(2);
});
it("T21 incomplete next-block roster does not roll back completed games or duplicate pair history",async()=>{
  await command(host,"assign-teams"); await command(host,"publish-teams");
  await getPool().query(`INSERT INTO team_blocks(event_id,team_id,block_no,phase,settings_json)
    SELECT event_id,id,1,'BLOCK_DONE',settings_json FROM teams WHERE event_id=$1`,[event.id]);
  await getPool().query(`UPDATE events SET phase='BLOCK',current_block=1,pending_config_json=config_json||'{"teamCount":4}'::jsonb WHERE id=$1`,[event.id]);
  const settle=()=>runCommand({slug:event.slug,tokenHash:host.tokenHash,command:"test-settle",payload:{},receipt:false},async ctx=>{await settleBlocks(ctx);return {};});
  expect(await settle()).toMatchObject({ok:true});
  expect((await getPool().query("SELECT phase,next_block_plan FROM events WHERE id=$1",[event.id])).rows[0]).toMatchObject({phase:"BREAK",next_block_plan:null});
  expect(await settle()).toMatchObject({ok:true});
  const counts=(await getPool().query("SELECT count(*)::int n,max(count) max FROM pair_history WHERE event_id=$1",[event.id])).rows[0];
  expect(counts).toEqual({n:63,max:1});
});
it("T04 promoting a student invalidates their old session until operator-code authentication",async()=>{
  const student=await createTestSession(event,event.students[0]);
  expect(await command(host,"upsert-participant",{participantId:event.students[0],displayName:"새운영진",role:"operator"})).toMatchObject({ok:true});
  expect((await getPool().query("SELECT revoked_at FROM sessions WHERE id=$1",[student.id])).rows[0].revoked_at).not.toBeNull();
  expect(await command(student,"assign-teams")).toMatchObject({ok:false,status:401});
});
