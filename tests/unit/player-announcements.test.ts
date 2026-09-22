import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicState } from "@/lib/contracts";
import MingleApp from "@/components/MingleApp";

const player = vi.hoisted(() => ({ state: null as PublicState | null }));
vi.mock("@/components/useMingleState", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/useMingleState")>(),
  useMingleState: () => ({ state: player.state, error: null, terminal: null, disconnected: false, busy: false,
    send: vi.fn(), refresh: vi.fn(), clearError: vi.fn() }),
}));

function stateFixture(): PublicState {
  return {
    serverNow: "2026-09-22T08:00:00.000Z", poll: { intervalMs: 2000, needsSync: false }, versions: { session: 1, game: 1, team: 1 },
    event: { slug: "announcement-review", title: "KANT Mingling", phase: "BLOCK", currentBlock: 2 },
    me: { participantId: "p1", displayName: "참가자 1", role: "student", isHost: false, profileComplete: true, introsSeen: [] },
    team: { key: "A", phase: "IN_GAME", paused: false, members: [], waitingForOthers: false, notInCurrentGame: false },
    game: { gameId: "game-4", gameNo: 4, phase: "TURN", turnLead: null, candidates: [], cards: [], exhausted: false,
      groundTruth: { cardNo: 6 }, pendingOverlay: { kind: "ground_truth", cardNo: 6 } },
    allowedActions: [],
  };
}

const render = () => renderToStaticMarkup(createElement(MingleApp, { slug: "announcement-review" }));

beforeEach(() => { player.state = stateFixture(); });

describe("Ground Truth announcements after restoring server state", () => {
  it("explains the rule on first exposure and retains the current card and acknowledgment", () => {
    const html = render();
    expect(html).toContain("Data 06 / Verified");
    expect(html).toContain("Noise가 아닙니다.");
    expect(html).toContain("추리 계속하기");
  });

  it("uses the saved intro acknowledgment on later Games but still announces their own Verified card", () => {
    player.state!.me!.introsSeen.push("ground_truth");
    Object.assign(player.state!.game!, { gameId: "game-5", gameNo: 5,
      groundTruth: { cardNo: 3 }, pendingOverlay: { kind: "ground_truth", cardNo: 3 } });
    const html = render();
    expect(html).toContain("Data 03 / Verified");
    expect(html).toContain("이번 Game의 Data 03이 확인되었습니다.");
    expect(html).not.toContain("Noise가 아닙니다.");
    expect(html).toContain("추리 계속하기");
    expect(render()).toBe(html);
  });

  it("does not reopen an already acknowledged Game announcement on refresh", () => {
    player.state!.me!.introsSeen.push("ground_truth");
    delete player.state!.game!.pendingOverlay;
    expect(render()).not.toContain("추리 계속하기");
    expect(render()).not.toContain("<dialog");
  });
});

describe("block completion and host-controlled ending", () => {
  beforeEach(() => {
    player.state!.team!.phase = "BLOCK_DONE";
    player.state!.game!.phase = "REVEALED";
    delete player.state!.game!.pendingOverlay;
    player.state!.game!.reveal = { owner: { participantId: "p2", displayName: "참가자 2" }, endReason: "correct", cards: [],
      behind: { choiceText: "함께 발견한 Data", followUp: "어떤 점이 같았나요?" } };
  });

  it.each([1, 2, 3])("waits for other teams at block %i until they finish", (block) => {
    player.state!.event.currentBlock = block;
    player.state!.team!.waitingForOthers = true;
    expect(render()).toContain("다른 조의 Game이 끝나기를 기다리고 있어요.");
    expect(render()).not.toContain("마지막 대화를 나눠보세요.");
  });

  it.each([1, 2])("waits for new seating to be published after block %i", (block) => {
    player.state!.event.currentBlock = block;
    player.state!.event.phase = "BREAK";
    const html = render();
    expect(html).toContain("다음 조 안내를 기다려주세요.");
    expect(html).toContain("호스트가 새 조를 공개하면 이동할 자리를 안내할게요.");
    expect(html).not.toContain("다른 조의 Game이 끝나기를 기다리고 있어요.");
  });

  it("keeps the final conversation open until the host ends the event", () => {
    player.state!.event.currentBlock = 3;
    player.state!.game!.gameNo = 9;
    const waiting = render();
    expect(waiting).toContain("모든 조의 Game이 끝났어요. 마지막 대화를 나눠보세요.");
    expect(waiting).toContain("호스트가 전체 행사를 종료할 때까지");
    expect(waiting).not.toContain("다른 조의 Game이 끝나기를 기다리고 있어요.");
    expect(waiting).not.toContain("KANT Mingling 완료");
    player.state!.event.phase = "ENDED";
    const ended = render();
    expect(ended).toContain("KANT Mingling 완료");
    expect(ended).not.toContain("호스트가 전체 행사를 종료할 때까지");
  });
});
