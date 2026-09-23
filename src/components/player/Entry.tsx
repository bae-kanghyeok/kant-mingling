"use client";

import { useState } from "react";
import type { PublicState } from "@/lib/contracts";
import type { SendAction } from "../useMingleState";
import { Modal, SectionTitle } from "../ui/Modal";
import { WelcomeSteps, WelcomeVisual } from "../ui/Brand";

const slides = [
  { title: "우리 중 한 명이 Data Owner입니다", body: "Data Owner는 본인도 자신이 선택됐는지 모릅니다.", detail: "공개되는 Data를 보고 우리 조의 Data Owner를 찾아보세요.", symbol: "?" },
  { title: "Data는 한 사람의 폰에만 도착합니다", body: "Data를 받은 사람은 내용을 직접 팀원에게 알려주세요.", detail: "다른 사람의 화면에는 내용이 보이지 않습니다. 서로 물어보고 이야기해야 합니다.", symbol: "↗" },
  { title: "마지막 Data를 받은 사람이 Turn Lead입니다", body: "Turn Lead가 팀원들과 상의해 다음 Data를 볼지, 추리할지 결정합니다.", detail: "Data를 서로 공유하고 충분히 이야기한 뒤 결정해보세요.", symbol: "↔" },
];
const gmSlides = [
  { title: "우리 조의 취향 주인공을 찾아봐요", body: "누군가 미리 고른 답이 단서로 하나씩 도착해요.", detail: "질문마다 여러분도 어느 쪽인지 골라보고 이유를 이야기해주세요. 내 Data 같아도 정체는 공개까지 잠깐 참아주세요.", symbol: "?" },
  { title: "단서를 읽고, 서로의 이야기를 들어요", body: "Data를 받은 사람이 질문과 답변을 팀에 읽어주세요.", detail: "같은 선택이어도 이유는 다를 수 있어요. 후보에서 제외됐다고 대화에서 빠질 필요는 없어요.", symbol: "↗" },
  { title: "추리할까요, 단서를 더 볼까요?", body: "GM이 여러분의 의견을 듣고 다음 단서나 추리를 열어줘요.", detail: "마지막 단서를 받은 사람이 팀의 추리를 제출해요. GM도 정답은 몰라요. 뒤에는 실제 답이 바뀐 Noise가 섞일 수 있어요.", symbol: "↔" },
];

export function Tutorial({ onDone, doneLabel = "프로필 만들기", gmMode = false }: { onDone: () => void; doneLabel?: string; gmMode?: boolean }) {
  const [step, setStep] = useState(0);
  const pages = gmMode ? gmSlides : slides;
  return <section className="panel tutorial">
    <div className="tutorial-progress" aria-label={`게임 방법 ${step + 1} / ${pages.length}`}>{pages.map((_, index) => <span key={index} className={index <= step ? "active" : ""} />)}</div>
    <div className="tutorial-slide" aria-live="polite">
      <span className="tutorial-symbol" aria-hidden="true">{pages[step].symbol}</span>
      <p className="eyebrow">How to mingle · 0{step + 1}</p><h1>{pages[step].title}</h1><p>{pages[step].body}</p><p className="muted">{pages[step].detail}</p>
    </div>
    <div className="action-grid tutorial-actions"><button className="button secondary" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}><span aria-hidden="true">←</span>이전</button><button className="button primary" onClick={() => step < pages.length - 1 ? setStep(step + 1) : onDone()}>{step < pages.length - 1 ? "다음" : doneLabel}<span aria-hidden="true">→</span></button></div>
  </section>;
}

export function Entry({ state, send, busy, initialStep = "welcome", initialOperatorId }: {
  state: PublicState; send: SendAction; busy: boolean;
  initialStep?: "welcome" | "tutorial" | "names"; initialOperatorId?: string;
}) {
  const [step, setStep] = useState(initialStep);
  const [operator, setOperator] = useState<PublicState["roster"] extends (infer T)[] | undefined ? T | null : never>(() => state.roster?.find((person) => person.role === "operator" && person.participantId === initialOperatorId) ?? null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const claim = async (participantId: string, operatorCode?: string) => {
    setError(null);
    try {
      await send(operatorCode === undefined ? "/api/session/claim" : "/api/session/operator", { participantId, ...(operatorCode === undefined ? {} : { code: operatorCode }) });
      await send("/api/game/intro-ack", { introKey: "tutorial" });
      setCode(""); setOperator(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "잠시 후 다시 시도해주세요."); }
  };
  if (step === "tutorial") return <Tutorial gmMode={state.event.gameplayMode === "gm"} onDone={() => setStep("names")} />;
  if (step === "welcome") return <section className="welcome">
    <div className="welcome-layout"><div className="welcome-copy">
      <p className="hero-kicker">Let’s get to know each other</p><h1>Whose<br /><em>Data?</em></h1><h2>{state.event.gameplayMode === "gm" ? "이야기 속에서 취향의 주인공을 찾아봐요." : "우리 중 한 명이 Data Owner입니다."}</h2><p className="muted">{state.event.gameplayMode === "gm" ? "여러분은 어느 쪽인가요? GM과 함께 선택과 이유를 나누고, 단서의 주인공을 찾아보세요." : "데이터는 각자의 폰에 흩어져 있습니다. 서로 이야기해 Data Owner를 찾아보세요."}</p>
      <button className="button primary full" onClick={() => setStep("tutorial")}>게임 방법 보기 <span aria-hidden="true">→</span></button>
    </div><WelcomeVisual /></div><WelcomeSteps />
  </section>;
  return <>
    <SectionTitle label="Check in" title="내 이름을 선택해주세요" description="오늘 함께할 얼굴들, 이름부터 만나봐요." />
    <button className="text-button small" onClick={() => setStep("tutorial")}>게임 방법 다시 보기</button>
    {error && <p className="error-message" role="alert">{error}</p>}
    <div className="name-grid">{state.roster?.map((person) => <button key={person.participantId} className="name-button" disabled={busy || (person.locked && person.role !== "operator")}
      onClick={() => person.role === "operator" ? setOperator(person) : void claim(person.participantId)}>
      <span className="avatar">{person.displayName.slice(-2)}</span><strong>{person.displayName}</strong><small>{person.role === "operator" ? "운영진" : person.locked ? "입장 완료" : "참가자"}</small>
    </button>)}</div>
    {state.roster?.some(person => person.locked) && <p className="small muted">이미 입장한 이름이에요. 내 이름이 맞다면 운영진에게 잠금 해제를 요청해주세요.</p>}
    {operator && <Modal title="운영진 코드를 입력해주세요" onClose={() => { setOperator(null); setCode(""); }}><form onSubmit={(event) => { event.preventDefault(); void claim(operator.participantId, code); }}>
      <p>{operator.displayName}</p><label className="field-label" htmlFor="operator-code">운영진 코드</label><input id="operator-code" autoFocus type="password" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} />
      {error && <p role="alert" className="error-message">{error}</p>}<button className="button primary full" disabled={busy || !code.trim()}>입장하기</button>
    </form></Modal>}
  </>;
}
