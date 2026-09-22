import { afterAll, afterEach, beforeEach, expect, it } from "vitest";
import { closePool, getPool } from "@/server/db/pool";
import { runCommand, type CommandResult } from "@/server/db/tx";
import { executeGameCommand } from "@/server/services/game-service";
import { cleanupTestEvent, createTestEvent, testRequest, type TestEvent } from "./helpers";
import { createVisibilityFixture } from "./visibility-fixture";

let event: TestEvent;
let fixture: Awaited<ReturnType<typeof createVisibilityFixture>>;
beforeEach(async () => {
  event = await createTestEvent();
  fixture = await createVisibilityFixture(event);
  await getPool().query("DELETE FROM ensemble_votes WHERE game_id=$1", [fixture.groups[0].game]);
  await getPool().query("UPDATE games SET phase='ENSEMBLE_VOTE',vote_deadline=clock_timestamp()+interval '1 minute' WHERE id=$1", [fixture.groups[0].game]);
});
afterEach(async () => { if (event) await cleanupTestEvent(event); });
afterAll(closePool);

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function vote(voter: string, pickId: string, revision = 0) {
  const args = { gameId: fixture.groups[0].game, pickId, revision };
  return runCommand({ ...testRequest(event, fixture.byPerson.get(voter)!), command: "ensemble-vote", payload: args },
    (ctx) => executeGameCommand(ctx, "ensemble-vote", args));
}

it("T17 different voters can hold their own rows and cast reciprocal ballots concurrently", async () => {
  const people = fixture.groups[0].people.slice(0, 2);
  const ready = people.map(signal);
  const proceed = signal();
  const requests = people.map((voter, index) => {
    const args = { gameId: fixture.groups[0].game, pickId: people[1 - index], revision: 0 };
    return runCommand({ ...testRequest(event, fixture.byPerson.get(voter)!), command: "ensemble-vote", payload: args }, async (ctx) => {
      // Keep both real voter locks alive before either ballot INSERT. This
      // exercises the selected participant FK while the other voter is active.
      await ctx.client.query("SELECT id FROM participants WHERE id=$1 FOR NO KEY UPDATE", [voter]);
      ready[index].resolve();
      await proceed.promise;
      return executeGameCommand(ctx, "ensemble-vote", args);
    });
  });
  try {
    await Promise.all(ready.map((entry) => entry.promise));
  } finally { proceed.resolve(); }
  expect(await Promise.all(requests)).toEqual([
    { ok: true, data: { revision: 1 } }, { ok: true, data: { revision: 1 } },
  ]);
  const persisted = await getPool().query<{ voter_id: string; pick_id: string; revision: number }>(
    "SELECT voter_id,pick_id,revision FROM ensemble_votes WHERE game_id=$1", [fixture.groups[0].game]);
  expect(persisted.rows).toHaveLength(2);
  expect(persisted.rows).toEqual(expect.arrayContaining(people.map((voter, index) => ({
    voter_id: voter, pick_id: people[1 - index], revision: 1,
  }))));
});

it("T17 the same voter racing different candidates at one revision commits exactly one ballot", async () => {
  const [voter, firstPick, secondPick] = fixture.groups[0].people;
  const results = await Promise.all([vote(voter, firstPick), vote(voter, secondPick)]);
  expect(results.filter((result) => result.ok)).toEqual([{ ok: true, data: { revision: 1 } }]);
  expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, status: 409, code: "STALE_REVISION" }]);
  const winner = results[0].ok ? firstPick : secondPick;
  expect((await getPool().query("SELECT voter_id,pick_id,revision FROM ensemble_votes WHERE game_id=$1", [fixture.groups[0].game])).rows)
    .toEqual([{ voter_id: voter, pick_id: winner, revision: 1 }]);
  expect((await getPool().query("SELECT game_version FROM games WHERE id=$1", [fixture.groups[0].game])).rows[0].game_version).toBe(0);
});

it("T17 a ballot waiting on its participant past the deadline is rejected and commits DISCUSS reconciliation", async () => {
  const [voter, pickId] = fixture.groups[0].people;
  const gameId = fixture.groups[0].game;
  const locker = await getPool().connect();
  const entered = signal();
  const proceed = signal();
  let backendPid = 0;
  let validatedAt = new Date(0);
  let pending: Promise<CommandResult<Record<string, unknown>>> | undefined;
  let settled: Promise<PromiseSettledResult<CommandResult<Record<string, unknown>>>[]> | undefined;
  try {
    await locker.query("BEGIN");
    const holderPid = (await locker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await locker.query("SELECT id FROM participants WHERE id=$1 FOR UPDATE", [voter]);
    const args = { gameId, pickId, revision: 0 };
    pending = runCommand({ ...testRequest(event, fixture.byPerson.get(voter)!), command: "ensemble-vote", payload: args }, async (ctx) => {
      backendPid = (await ctx.client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      validatedAt = ctx.now;
      entered.resolve();
      await proceed.promise;
      return executeGameCommand(ctx, "ensemble-vote", args);
    });
    // Attach a rejection handler immediately so failed assertions still release
    // every database lock before the fixture cleanup runs.
    settled = Promise.allSettled([pending]);
    await entered.promise;
    const deadline = (await getPool().query<{ vote_deadline: Date }>(
      "UPDATE games SET vote_deadline=clock_timestamp()+interval '1500 milliseconds' WHERE id=$1 RETURNING vote_deadline", [gameId],
    )).rows[0].vote_deadline;
    expect(validatedAt.getTime()).toBeLessThan(deadline.getTime());
    proceed.resolve();

    let observedBlocked = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const observation = (await locker.query<{ blocked: boolean; before_deadline: boolean }>(
        "SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked,clock_timestamp()<$3::timestamptz AS before_deadline",
        [backendPid, holderPid, deadline],
      )).rows[0];
      if (observation.blocked) {
        expect(observation.before_deadline).toBe(true);
        observedBlocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(observedBlocked).toBe(true);
    await locker.query("SELECT pg_sleep(GREATEST(0,extract(epoch FROM ($1::timestamptz-clock_timestamp())))+0.05)", [deadline]);
    await locker.query("COMMIT");
    expect(await pending).toEqual({ ok: false, status: 409, code: "WRONG_PHASE" });
    expect((await getPool().query("SELECT voter_id FROM ensemble_votes WHERE game_id=$1", [gameId])).rows).toEqual([]);
    expect((await getPool().query("SELECT phase,game_version FROM games WHERE id=$1", [gameId])).rows[0])
      .toEqual({ phase: "ENSEMBLE_DISCUSS", game_version: 1 });
  } finally {
    proceed.resolve();
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
    if (settled) await settled;
  }
});
