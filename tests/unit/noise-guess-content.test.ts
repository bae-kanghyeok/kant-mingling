import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GuessModal } from "@/components/player/GameOverlays";
import { createPreviewState } from "@/components/design/fixtures";

describe("Noise candidate content without expanding card visibility", () => {
  const render = (includeTeamReview = false) => {
    const state = createPreviewState("guess");
    delete state.game!.guess!.cards;
    state.game!.cards = [
      { cardNo: 1, recipients: [{ participantId: "design-student-1", displayName: "학생01" }],
        question: { category: "날씨 취향", options: { A: "365일 장마", B: "365일 폭염" } }, text: "365일 폭염" },
      { cardNo: 2, recipients: [{ participantId: "design-student-2", displayName: "학생02" }] },
      { cardNo: 3, recipients: [{ participantId: "design-student-1", displayName: "학생01" }],
        text: "긴_답변도_생략하지_않고_읽을_수_있는_단서", verified: true },
    ];
    if (includeTeamReview) state.game!.guess!.cards = [{ cardNo: 2,
      question: { category: "대화 취향", options: { A: "대면 대화", B: "문자로 대화" } }, text: "문자로 대화" }];
    return renderToStaticMarkup(createElement(GuessModal, {
      state, game: state.game!, send: vi.fn(), busy: false, onClose: vi.fn(), onWrong: vi.fn(),
    }));
  };

  it("shows the available original question and selected answer instead of number-only choices", () => {
    const html = render();
    expect(html).toContain("날씨 취향");
    expect(html).toContain("365일 장마");
    expect(html).toContain("365일 폭염");
    expect(html).toContain("선택한 답변");
    expect(html).toContain("긴_답변도_생략하지_않고_읽을_수_있는_단서");
    expect(html.match(/class="choice-button noise-choice/g)).toHaveLength(3);
  });

  it("keeps unreceived content undisclosed and Verified cards disabled", () => {
    const html = render();
    expect(html).toContain("학생02님에게 전달된 Data");
    expect(html).toContain("받은 사람에게 내용을 확인한 뒤 선택해주세요.");
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
    const unreceived = buttons.find((button) => button.includes("Data 02"));
    expect(unreceived).not.toContain("noise-choice-question");
    expect(unreceived).not.toContain("noise-choice-answer");
    const verified = buttons.find((button) => button.includes("Data 03"));
    expect(verified).toContain('disabled=""');
    expect(verified).toContain("Verified · 선택 불가");
  });

  it("uses the separately authorized team review only inside Noise choices", () => {
    const html = render(true);
    expect(html).toContain("대면 대화");
    expect(html).toContain("문자로 대화");
    expect(html).not.toContain("학생02님에게 전달된 Data");
  });
});
