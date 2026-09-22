import { loadLocalEnvironment,openDevelopmentClient,assertDevelopmentMarker,safeFailure } from "./helpers/database.mjs";
import { readOptions,validateSlug,lockEvent } from "./helpers/event-admin.mjs";
let client;
try {
  const options=readOptions(process.argv.slice(2),["--slug"],["--synthetic"]);
  const slug=validateSlug({environment:"development"},options.slug,options);
  loadLocalEnvironment();client=await openDevelopmentClient();await assertDevelopmentMarker(client);
  await client.query("BEGIN");
  const event=await lockEvent(client,slug);
  if(event.phase!=="SETUP") throw new Error("Only an unstarted synthetic event can be prepared.");
  const people=(await client.query("SELECT display_name,role FROM participants WHERE event_id=$1",[event.id])).rows;
  if(!people.length||people.some(p=>!new RegExp(p.role==="student"?"^학생\\d{2,}$":"^운영진[A-Z]+$").test(p.display_name))) throw new Error("Synthetic identities are required.");
  await client.query(`INSERT INTO profile_answers(event_id,participant_id,question_id,option,revision)
    SELECT p.event_id,p.id,'Q'||lpad(n::text,2,'0'),CASE WHEN (p.roster_order*7+n*3+(p.roster_order*n)%5)%11<6 THEN 'A' ELSE 'B' END,1
    FROM participants p CROSS JOIN generate_series(1,20) n WHERE p.event_id=$1 AND p.active
    ON CONFLICT(participant_id,question_id) DO NOTHING`,[event.id]);
  await client.query("UPDATE participants SET profile_completed_at=COALESCE(profile_completed_at,clock_timestamp()) WHERE event_id=$1 AND active",[event.id]);
  await client.query("INSERT INTO operation_logs(event_id,command) VALUES($1,'prepare-synthetic-profiles')",[event.id]);
  await client.query("COMMIT");
  console.log("Missing synthetic profiles prepared. Existing answers preserved. Start the rehearsal from the host screen.");
} catch {if(client)await client.query("ROLLBACK").catch(()=>{});safeFailure("Synthetic profile preparation");}
finally {if(client)await client.end().catch(()=>{});}
