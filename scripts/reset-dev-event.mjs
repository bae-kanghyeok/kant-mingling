import {
  loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker,
  optionValue, safeFailure,
} from "./helpers/database.mjs";

let client;
try {
  const args = process.argv.slice(2);
  const slug = optionValue(args, "--slug");
  if (args.length !== 2 || !slug || !/^(dev|test)-[a-z0-9-]+$/i.test(slug)) {
    throw new Error("A synthetic dev-/test- event slug is required.");
  }
  loadLocalEnvironment();
  client = await openDevelopmentClient();
  await assertDevelopmentMarker(client);
  await client.query("BEGIN");
  const result = await client.query("SELECT id FROM events WHERE slug = $1 FOR UPDATE", [slug]);
  if (result.rows[0]) {
    const id = result.rows[0].id;
    // GAME/participant references cross the event's cascade tree; remove children first.
    await client.query("DELETE FROM ground_truths WHERE game_id IN (SELECT id FROM games WHERE event_id=$1)", [id]);
    await client.query("UPDATE team_blocks SET current_game_id=NULL WHERE event_id=$1", [id]);
    await client.query("DELETE FROM games WHERE event_id=$1", [id]);
    await client.query("DELETE FROM team_blocks WHERE event_id=$1", [id]);
    await client.query("DELETE FROM teams WHERE event_id=$1", [id]);
    await client.query("DELETE FROM events WHERE id=$1", [id]);
  }
  await client.query("COMMIT");
  console.log(result.rowCount ? "Synthetic development event removed." : "No matching synthetic development event.");
} catch {
  if (client) await client.query("ROLLBACK").catch(() => {});
  safeFailure("Development reset");
} finally {
  if (client) await client.end().catch(() => {});
}
