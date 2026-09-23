import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GameBoard, BlockDoneNotice } from "@/components/player/GameBoard";
import { GMRemote } from "@/components/admin/GMRemote";
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
  it("provides GM pacing without revealing another recipient's card", () => {
    const state = createPreviewState("gm-remote");
    const html = renderToStaticMarkup(createElement(GMRemote, { state, send: vi.fn(), busy: false }));
    expect(html).toContain("다음 단서");
    expect(html).toContain("추리 열기");
    expect(html).not.toContain("365일 폭염");
    state.me!.role = "student";
    expect(renderToStaticMarkup(createElement(GMRemote, { state, send: vi.fn(), busy: false }))).toBe("");
  });
  it("does not treat the third rotation as the event finale", () => {
    const state = createPreviewState("gm-rotation");
    state.event.currentBlock = 3;
    const html = renderToStaticMarkup(createElement(BlockDoneNotice, { state }));
    expect(html).not.toContain("모든 조의 Game이 끝났어요");
    expect(html).toContain("새 조를 공개하면");
  });
});
