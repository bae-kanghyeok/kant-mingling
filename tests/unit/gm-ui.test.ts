import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GameBoard, BlockDoneNotice, Reveal } from "@/components/player/GameBoard";
import { GuessModal } from "@/components/player/GameOverlays";
import { GMRemote } from "@/components/admin/GMRemote";
import { AdminPanel } from "@/components/admin/AdminPanel";
import { createPreviewState } from "@/components/design/fixtures";

describe("GM participant and facilitator surfaces", () => {
  const board = (view: "gm-talk" | "gm-guess", locked = false) => {
    const state = createPreviewState(view);
    state.game!.guess!.locked = locked;
    return renderToStaticMarkup(createElement(GameBoard, { state, game: state.game!, send: vi.fn(), busy: false }));
  };
  it("keeps participant next-card controls absent and only enables an opened guess", () => {
    const closed = board("gm-talk");
    expect(closed).not.toContain("Data 하나 더 보기");
    expect(closed).toMatch(/<button[^>]*disabled=""[^>]*>GM이 추리를 열어줄 거예요/);
    expect(board("gm-guess")).toMatch(/<button class="button primary">추리하기/);
  });
  it("restores wrong-answer guidance from server state after refresh", () => {
    expect(board("gm-talk", true)).toContain("아직 정답이 아니에요");
  });
  it("tells the whole team who a wrong guess ruled out, then keeps a quiet reminder", () => {
    const state = createPreviewState("gm-talk");
    const [first, second] = state.game!.candidates;
    state.game!.ruledOut = [{ ...first, atCard: state.game!.cards.length }];
    delete state.game!.guess;
    state.game!.turnLead = second;
    const render = () => renderToStaticMarkup(createElement(GameBoard, { state, game: state.game!, send: vi.fn(), busy: false }));
    expect(render()).toContain(`${first.displayName}님은 Data Owner가 아니에요!`);
    state.game!.ruledOut = [{ ...first, atCard: state.game!.cards.length - 1 }];
    const later = render();
    expect(later).toContain(`앞선 추리에서 아니었던 분: ${first.displayName}`);
    expect(later).not.toContain("Data Owner가 아니에요!");
  });
  it("marks ruled-out people in the next guess without disabling them", () => {
    const state = createPreviewState("gm-guess");
    const first = state.game!.candidates[0];
    state.game!.ruledOut = [{ ...first, atCard: 1 }];
    const html = renderToStaticMarkup(createElement(GuessModal, { state, game: state.game!, send: vi.fn(), busy: false, onClose: vi.fn(), onWrong: vi.fn() }));
    const button = (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((item) => item.includes(first.displayName))!;
    expect(button).toContain("앞선 추리에서 아니었어요");
    expect(button).not.toContain("disabled");
  });
  it("names the Noise Data on a GM reveal", () => {
    const state = createPreviewState("gm-reveal");
    const game = state.game ?? state.lastReveal!;
    game.gm = { guessOpen: false };
    game.reveal!.cards[0].status = "NOISE";
    const html = renderToStaticMarkup(createElement(Reveal, { game }));
    expect(html).toContain("이번 판 Noise");
    expect(html).toContain(`Data ${String(game.reveal!.cards[0].cardNo).padStart(2, "0")}`);
  });
  it("provides GM pacing without revealing another recipient's card", () => {
    const state = createPreviewState("gm-remote");
    const html = renderToStaticMarkup(createElement(GMRemote, { state, send: vi.fn(), busy: false }));
    expect(html).toContain("다음 단서");
    expect(html).toContain("추리 열기");
    expect(html).not.toContain("365일 폭염");
    state.me!.role = "student";
    expect(renderToStaticMarkup(createElement(GMRemote, { state, send: vi.fn(), busy: false }))).toBe("");
  });
  it("shows a team GM only their own team without head GM tools or logs", () => {
    const state = createPreviewState("gm-remote");
    const render = () => renderToStaticMarkup(createElement(AdminPanel, { state, send: vi.fn(), busy: false, onClose: vi.fn() }));
    expect(state.admin!.teams.length).toBeGreaterThan(1);
    const hostHtml = render();
    expect(hostHtml).toContain("전체 진행 · 총괄 GM");
    expect(hostHtml.match(/class="admin-team-card/g)).toHaveLength(state.admin!.teams.length);
    state.admin!.isHost = false;
    const teamHtml = render();
    expect(teamHtml).not.toContain("전체 진행 · 총괄 GM");
    expect(teamHtml).not.toContain("조 선택");
    expect(teamHtml).not.toContain(">로그</button>");
    expect(teamHtml.match(/class="admin-team-card/g)).toHaveLength(1);
    expect(teamHtml).toContain("정답 공개하고 이번 판 끝내기");
  });
  it("previews the wrong-guess notice, the team GM remote and the host lobby", () => {
    const wrong = createPreviewState("gm-wrong");
    expect(renderToStaticMarkup(createElement(GameBoard, { state: wrong, game: wrong.game!, send: vi.fn(), busy: false }))).toContain("Data Owner가 아니에요!");
    const vote = createPreviewState("gm-vote");
    expect(renderToStaticMarkup(createElement(GameBoard, { state: vote, game: vote.game!, send: vi.fn(), busy: false }))).toContain("추리에서 아니었어요");
    const team = createPreviewState("gm-team-remote");
    const teamHtml = renderToStaticMarkup(createElement(AdminPanel, { state: team, send: vi.fn(), busy: false, onClose: vi.fn() }));
    expect(teamHtml).not.toContain("전체 진행 · 총괄 GM");
    const lobby = createPreviewState("gm-lobby");
    const lobbyHtml = renderToStaticMarkup(createElement(AdminPanel, { state: lobby, send: vi.fn(), busy: false, onClose: vi.fn() }));
    expect(lobbyHtml).toContain(`입장 ${lobby.event.presence!.entered} / ${lobby.event.presence!.total}명`);
    expect(lobbyHtml).toContain("아직 입장 전:");
    expect(lobbyHtml).toContain("20문항 작성 중:");
    expect(lobbyHtml).toContain("결석 표시:");
  });
  it("does not treat the third rotation as the event finale", () => {
    const state = createPreviewState("gm-rotation");
    state.event.currentBlock = 3;
    const html = renderToStaticMarkup(createElement(BlockDoneNotice, { state }));
    expect(html).not.toContain("모든 조의 Game이 끝났어요");
    expect(html).toContain("새 조를 공개하면");
  });
});
