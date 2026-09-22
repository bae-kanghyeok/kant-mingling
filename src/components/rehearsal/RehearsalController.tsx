"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import type { RehearsalState } from "@/lib/rehearsal-contracts";
import DesignPreview from "../design/DesignPreview";
import { Brand } from "../ui/Brand";
import { Modal } from "../ui/Modal";
import styles from "./RehearsalController.module.css";

type Action = "enable" | "switch" | "assist" | "disable" | "reset" | "start" | "focus-turn";

class RehearsalError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function fetchRehearsal(slug: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<RehearsalState> {
  const response = await fetch(`/api/rehearsal?slug=${encodeURIComponent(slug)}`, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(30000),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, ...body }) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok !== true) {
    throw new RehearsalError(response.status, result.error?.code ?? "REQUEST_FAILED", result.error?.message ?? "리허설 연결을 확인하지 못했어요.");
  }
  return result as RehearsalState;
}

function failureMessage(error: unknown) {
  if (!(error instanceof RehearsalError)) return "연결이 잠시 끊겼거나 응답이 늦어지고 있어요. 상태를 새로 확인한 뒤 이어가세요.";
  if (error.status === 404) return "이 환경에서는 리허설을 열 수 없어요. 전달받은 Preview 주소와 행사 링크를 확인해주세요.";
  if (error.status === 503) return "개발 DB에 연결하지 못했어요. 잠시 후 ‘상태 새로고침’을 눌러주세요.";
  if (error.code === "BAD_CODE") return "호스트 코드가 맞지 않아요. 전달받은 코드를 다시 입력해주세요.";
  if (error.status === 401 || error.status === 403) return "호스트 인증을 다시 확인해주세요. 운영진 코드로 리허설을 다시 켤 수 있어요.";
  return error.message;
}

const actionLabels: Record<Action, string> = {
  enable: "호스트 인증을 확인하고 있어요.",
  switch: "선택한 참가자의 화면으로 전환하고 있어요.",
  assist: "다른 참가자의 데모 응답을 반영하고 있어요.",
  disable: "리허설 감독을 종료하고 있어요.",
  reset: "리허설을 처음 상태로 되돌리고 있어요.",
  start: "조를 편성하고 첫 게임을 시작하고 있어요.",
  "focus-turn": "지금 진행할 참가자의 화면을 찾고 있어요.",
};

export default function RehearsalController({ slug }: { slug: string }) {
  const [mode, setMode] = useState<"tour" | "live">("tour");
  const [working, setWorking] = useState(false);

  return <div>
    <div className={styles.shell}>
      <header className={styles.header}><Brand /><span className={styles.liveBadge}>상사님용 게임 체험</span></header>
      <nav className={styles.modes} aria-label="테스트 방법">
        <button className={mode === "tour" ? styles.activeMode : styles.mode} aria-pressed={mode === "tour"} disabled={working} onClick={() => setMode("tour")}>
          <strong>화면 둘러보기</strong><span>로그인 없이 모든 단계 바로 확인 · 저장 안 됨</span>
        </button>
        <button className={mode === "live" ? styles.activeMode : styles.mode} aria-pressed={mode === "live"} disabled={working} onClick={() => setMode("live")}>
          <strong>실제 게임</strong><span>호스트 코드로 역할 전환 · DB에 진행 저장</span>
        </button>
      </nav>
    </div>
    {mode === "tour" ? <DesignPreview embedded /> : <LiveRehearsalController slug={slug} onWorkingChange={setWorking} />}
  </div>;
}

function LiveRehearsalController({ slug, onWorkingChange }: { slug: string; onWorkingChange: (working: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<RehearsalState | null>(null);
  const [selection, setSelection] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<Action | "refresh" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [frameMounted, setFrameMounted] = useState(false);
  const [frameVersion, setFrameVersion] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const actionInFlight = useRef(false);
  const gamePanel = useRef<HTMLElement>(null);
  const focusGame = useRef(false);

  useEffect(() => {
    const abort = new AbortController();
    void fetchRehearsal(slug, undefined, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]))
      .then((next) => {
        if (abort.signal.aborted) return;
        setSnapshot(next);
        setSelection(next.selectedParticipantId ?? next.hostParticipantId);
        setFrameMounted(next.enabled);
      })
      .catch((failure) => { if (!abort.signal.aborted) setError(failureMessage(failure)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [slug]);

  useEffect(() => {
    if (!frameMounted || !focusGame.current) return;
    focusGame.current = false;
    if (window.matchMedia("(max-width: 760px)").matches) {
      gamePanel.current?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
  }, [frameMounted, frameVersion]);

  const selectedPerson = snapshot?.roster.find((person) => person.participantId === snapshot.selectedParticipantId);
  const host = snapshot?.roster.find((person) => person.participantId === snapshot.hostParticipantId);
  const students = snapshot?.roster.filter((person) => person.role === "student") ?? [];
  const operators = snapshot?.roster.filter((person) => person.role === "operator") ?? [];
  const enabled = snapshot?.enabled === true;
  const disabled = busy !== null || loading || needsRefresh;

  function accept(next: RehearsalState, openFrame: boolean) {
    setSnapshot(next);
    setSelection(next.selectedParticipantId ?? next.hostParticipantId);
    setNeedsRefresh(false);
    setFrameVersion((value) => value + 1);
    setFrameMounted(next.enabled && openFrame);
  }

  async function refresh() {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    onWorkingChange(true);
    const reopen = frameMounted;
    flushSync(() => { setBusy("refresh"); setFrameMounted(false); setError(null); });
    try {
      accept(await fetchRehearsal(slug), reopen);
      setNotice("리허설 상태를 확인했어요.");
    } catch (failure) {
      setError(failureMessage(failure));
      setNeedsRefresh(true);
    } finally {
      setLoading(false);
      setBusy(null);
      actionInFlight.current = false;
      onWorkingChange(false);
    }
  }

  async function run(action: Action, extra: Record<string, unknown> = {}) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    onWorkingChange(true);
    // Remove the old document before a response can change the shared game cookie.
    // Only the remounted iframe may start polling with the newly selected identity.
    flushSync(() => { setBusy(action); setFrameMounted(false); setError(null); setNotice(null); });
    try {
      const next = await fetchRehearsal(slug, { action, ...extra });
      focusGame.current = action !== "disable";
      accept(next, action !== "disable");
      if (action === "enable") setNotice("호스트 인증을 마쳤어요. 참가자 역할을 바꾸며 실제 게임을 확인해보세요.");
      if (action === "switch") setNotice("역할을 바꿨어요. 아래 게임 화면에서도 이름을 확인해주세요.");
      if (action === "assist") setNotice((next.assistedActions ?? 0) > 0
        ? `다른 참가자의 데모 동작 ${next.assistedActions}개를 반영했어요. 다음 진행은 게임 화면에서 확인해주세요.`
        : "지금 보조할 동작이 없어요. 현재 역할의 안내나 조의 진행 단계를 확인해주세요.");
      if (action === "disable") setNotice("리허설 감독을 종료했어요. 행사 진행과 프로필은 그대로 남아 있어요.");
      if (action === "reset") { setResetOpen(false); setNotice("처음 상태로 되돌렸어요. 21명의 프로필이 준비되어 있으니 ‘게임 바로 시작’을 눌러주세요."); }
      if (action === "start") setNotice("첫 게임이 준비됐어요. ‘현재 진행자 화면’으로 이동해 시작해보세요.");
      if (action === "focus-turn") setNotice("현재 조에서 진행할 참가자로 전환했어요. 게임 화면의 안내대로 진행해주세요.");
    } catch (failure) {
      setError(failureMessage(failure));
      setNeedsRefresh(action !== "enable");
      if (failure instanceof RehearsalError && (failure.status === 401 || failure.status === 403)) {
        setSnapshot((previous) => previous ? { ...previous, enabled: false } : previous);
      }
    } finally {
      setCode("");
      setBusy(null);
      actionInFlight.current = false;
      onWorkingChange(false);
    }
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim()) void run("enable", { code: code.trim() });
  }

  return <main className={styles.shell}>
    <section className={styles.intro}>
      <p className="eyebrow">실제 DB로 진행하는 합성 리허설</p>
      <h1>직접 조작하며 게임을 이어가요.</h1>
      <p>합성 참가자 21명의 프로필이 준비되어 있어요. 호스트 인증 후 게임을 바로 시작하고, 역할을 바꿔 전체 진행을 확인하세요. 화면 둘러보기로 이동하면 실제 게임의 자동 조회를 멈추며 저장된 진행은 유지됩니다.</p>
    </section>
    <div className={styles.workspace}>
      <aside className={styles.controls} aria-label="리허설 감독">
        <div className={styles.controlHeading}><h2>리허설 감독</h2><span className={enabled ? styles.onBadge : styles.offBadge}>{enabled ? "활성" : "인증 필요"}</span></div>
        <p className={styles.description}>이 탭 하나에서 진행해주세요. 선택한 역할의 게임 화면만 연결합니다.</p>
        {loading && <p className={styles.feedback} role="status">리허설 환경을 확인하고 있어요.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {notice && <p className={styles.feedback} role="status">{notice}</p>}

        {snapshot && !enabled && <form className={styles.login} onSubmit={login}>
          <h3>호스트 인증으로 시작해요</h3>
          <p>{host?.displayName ?? "호스트 운영진"}에게 지급된 코드를 입력해주세요. 운영진 인증을 마치면 참가자 역할을 전환할 수 있어요.</p>
          <label htmlFor="rehearsal-host-code">호스트 운영진 코드</label>
          <input id="rehearsal-host-code" type="password" value={code} onChange={(event) => setCode(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} required disabled={busy !== null} />
          <button type="submit" className="button primary full" disabled={busy !== null || !code.trim()}>호스트로 로그인 · 리허설 켜기</button>
          <p className={styles.hint}>코드는 인증 요청 후 입력창에서 지워집니다.</p>
        </form>}

        {enabled && <>
          <section className={styles.controlSection}>
            <h3>빠른 시작</h3>
            <button className="button primary full" disabled={disabled || snapshot.eventPhase !== "SETUP"} onClick={() => void run("start")}>{snapshot.eventPhase === "SETUP" ? "게임 바로 시작" : "게임이 시작되었어요"}</button>
            <button className="button secondary full" disabled={disabled || snapshot.eventPhase !== "BLOCK"} onClick={() => void run("focus-turn")}>현재 진행자 화면</button>
            <p className={styles.hint}>첫 시작은 조 편성부터 Game 1까지 자동으로 준비해요. 진행자 버튼은 현재 조의 Turn Lead 또는 Ensemble 공유자로 전환합니다.</p>
            <button className={styles.resetButton} disabled={disabled} onClick={() => setResetOpen(true)}>처음부터 다시 시작</button>
          </section>
          <section className={styles.controlSection}>
            <label htmlFor="rehearsal-participant">참가자 역할</label>
            <select id="rehearsal-participant" value={selection} onChange={(event) => setSelection(event.target.value)} disabled={disabled}>
              <optgroup label="운영진">{operators.map((person) => <option key={person.participantId} value={person.participantId}>{person.displayName}{person.participantId === snapshot.hostParticipantId ? " · 호스트" : ""}</option>)}</optgroup>
              <optgroup label="수강생">{students.map((person) => <option key={person.participantId} value={person.participantId}>{person.displayName}</option>)}</optgroup>
            </select>
            <button className="button primary full" disabled={disabled || !selection} onClick={() => void run("switch", { participantId: selection })}>선택한 역할로 전환</button>
            <button className="button secondary full" disabled={disabled || !host || selectedPerson?.participantId === host.participantId} onClick={() => void run("switch", { participantId: snapshot.hostParticipantId })}>호스트로 돌아가기</button>
            <p className={styles.hint}>호스트의 게임 화면에서 ‘관리자’를 누르면 전체 시작, 다음 블록, 종료를 제어할 수 있어요.</p>
          </section>
          <section className={styles.controlSection}>
            <h3>다른 참가자가 필요한 순간</h3>
            <p className={styles.description}>현재 역할이 속한 조의 다른 참가자들이 안내 확인·Data 공유·투표·토론 마침을 하도록 보조합니다. 다른 조를 확인하려면 그 조의 참가자로 전환해주세요.</p>
            <button className="button secondary full" disabled={disabled} onClick={() => void run("assist")}>다른 참가자 데모 응답</button>
            <p className={styles.hint}>현재 역할의 조작, 단서 요청, 추리, 다음 Game과 블록 이동은 직접 진행해주세요.</p>
          </section>
          <button className={styles.endButton} disabled={busy !== null} onClick={() => void run("disable")}>리허설 감독 종료</button>
          <p className={styles.hint}>감독 종료는 로그아웃입니다. 행사 진행과 저장한 답변을 지우지 않아요.</p>
        </>}
        <button className={styles.refreshButton} disabled={busy !== null} onClick={() => void refresh()}>상태 새로고침</button>
        <details className={styles.help}>
          <summary>리허설 진행 방법</summary>
          <ol><li>호스트 코드로 로그인하고 ‘게임 바로 시작’을 누릅니다.</li><li>‘현재 진행자 화면’에서 단서 요청과 추리를 해봅니다.</li><li>확인·공유·투표에 다른 참가자가 필요하면 ‘다른 참가자 데모 응답’을 누릅니다.</li><li>참가자 역할을 바꿔 다른 조나 운영진의 화면을 확인합니다.</li><li>호스트로 돌아가 ‘관리자’에서 다음 블록, 자리 이동, 종료를 제어합니다.</li><li>다시 해보려면 ‘처음부터 다시 시작’을 누릅니다.</li></ol>
          <p>선택한 역할이 받을 수 있는 Data만 보입니다. 공개 전 정답과 다른 사람의 Data를 모아 보여주는 기능은 없어요.</p>
        </details>
      </aside>

      <section ref={gamePanel} className={styles.gamePanel} aria-label="현재 참가자 게임 화면">
        <div className={styles.gameHeader}>
          <div><span className={styles.gameEyebrow}>현재 게임 화면</span><h2>{enabled ? selectedPerson?.displayName ?? "참가자를 선택해주세요" : "호스트 인증 후 열립니다"}</h2></div>
          {enabled && <button className="button secondary small" disabled={disabled} onClick={() => {
            focusGame.current = !frameMounted;
            setFrameMounted((open) => !open);
            if (!frameMounted) setFrameVersion((value) => value + 1);
          }}>{frameMounted ? "게임 화면 잠시 닫기" : "게임 화면 다시 열기"}</button>}
        </div>
        {enabled && frameMounted && !busy && !needsRefresh
          ? <iframe key={`${snapshot.selectedParticipantId ?? "entry"}-${frameVersion}`} className={styles.frame} src={`/e/${encodeURIComponent(slug)}`} title={`${selectedPerson?.displayName ?? "현재 참가자"}의 실제 게임`} />
          : <div className={styles.emptyFrame} role="status">
            <span className={styles.emptyMark} aria-hidden="true">{busy ? "↻" : enabled ? "Ⅱ" : "↗"}</span>
            <h3>{busy === "refresh" ? "상태를 새로 확인하고 있어요." : busy ? actionLabels[busy] : needsRefresh ? "상태를 확인한 뒤 이어가세요." : enabled ? "게임 화면을 잠시 닫았어요." : "호스트 인증부터 시작해주세요."}</h3>
            <p>{busy ? "이전 참가자의 연결을 닫고 처리하고 있어요." : enabled ? "게임 화면이 닫힌 동안 자동 상태 조회를 멈춥니다. 저장된 진행은 유지돼요." : "지급받은 운영진 코드로 로그인하면 실제 참가자 화면이 여기에 열립니다."}</p>
          </div>}
        <p className={styles.frameNote}>게임 화면은 한 번에 하나만 연결합니다. 쉬어갈 때는 화면을 잠시 닫거나 리허설 감독을 종료해주세요.</p>
      </section>
    </div>
    {resetOpen && <Modal title="리허설을 처음부터 다시 할까요?" onClose={busy ? undefined : () => setResetOpen(false)}>
      <p className={styles.resetDescription}>이 리허설의 게임 진행, 조 편성, 투표와 기록을 지우고 합성 참가자 21명의 프로필을 다시 채웁니다. 기존 운영진 코드는 계속 사용할 수 있어요.</p>
      <div className={styles.resetActions}>
        <button className="button secondary" disabled={busy !== null} onClick={() => setResetOpen(false)}>취소</button>
        <button className="button primary" disabled={busy !== null} onClick={() => void run("reset", { confirm: "RESET" })}>{busy === "reset" ? "초기화 중…" : "초기화하고 다시 준비"}</button>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </Modal>}
  </main>;
}
