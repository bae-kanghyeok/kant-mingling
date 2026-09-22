"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import type { RehearsalState } from "@/lib/rehearsal-contracts";
import { Brand } from "../ui/Brand";
import styles from "./RehearsalController.module.css";

type Action = "enable" | "switch" | "assist" | "disable";

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
};

export default function RehearsalController({ slug }: { slug: string }) {
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
    }
  }

  async function run(action: Action, extra: Record<string, unknown> = {}) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
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
    }
  }

  function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (code.trim()) void run("enable", { code: code.trim() });
  }

  return <main className={styles.shell}>
    <header className={styles.header}><Brand /><span className={styles.liveBadge}>실제 DB로 진행</span></header>
    <section className={styles.intro}>
      <p className="eyebrow">온라인 합성 리허설</p>
      <h1>혼자서도 함께하는 게임을 확인해요.</h1>
      <p>합성 참가자 21명의 역할을 바꾸며 참가자 화면과 호스트 관제를 확인합니다. 화면 예시가 아닌, 개발 DB에 저장되는 실제 게임이에요.</p>
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
          <ol><li>호스트 코드로 로그인하고 게임 화면을 엽니다.</li><li>호스트 ‘관리자’ 화면에서 조 편성과 전체 시작을 진행합니다.</li><li>역할을 바꿔 각 참가자에게 보이는 단서를 확인합니다.</li><li>다른 참가자의 확인·공유·투표가 필요할 때 데모 응답을 누릅니다.</li><li>호스트로 돌아가 다음 Game, 자리 이동, 전체 종료를 확인합니다.</li></ol>
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
  </main>;
}
