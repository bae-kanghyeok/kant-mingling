"use client";

import { useEffect, useRef, useState } from "react";
import { questions, type Option } from "@/content/catalog";
import type { PublicState } from "@/lib/contracts";
import { ApiError, requestJson, type ApiResult, type SendAction } from "../useMingleState";
import { SectionTitle } from "../ui/Modal";

export function Profile({ state, slug, send, onDone, persistence = requestJson }: { state: PublicState; slug: string; send: SendAction; onDone?: () => void; persistence?: typeof requestJson }) {
  const [answers, setAnswers] = useState(state.profile?.answers ?? {});
  const [saveState, setSaveState] = useState(Object.keys(state.profile?.answers ?? {}).length === 20 ? "답변이 저장되었어요" : "모든 질문에 답하면 다음 단계로 갈 수 있어요.");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const desired = useRef({ ...state.profile?.answers });
  const saved = useRef({ ...state.profile?.answers });
  const revisions = useRef({ ...state.profile?.revisions });
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const jobs = useRef(new Map<string, Promise<void>>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const activeTimers = timers.current;
    return () => { mounted.current = false; activeTimers.forEach(clearTimeout); };
  }, []);

  const save = (id: string): Promise<void> => {
    const existing = jobs.current.get(id);
    if (existing) return existing;
    const job = (async () => {
      let conflicts = 0;
      while (desired.current[id] !== saved.current[id]) {
        const option = desired.current[id];
        if (!option) break;
        try {
          const response = await persistence<ApiResult>("/api/profile", { slug, questionId: id, option, revision: revisions.current[id] ?? 0 }, "PATCH");
          const revision = response.revision ?? response.data?.revision;
          revisions.current[id] = typeof revision === "number" ? revision : (revisions.current[id] ?? 0) + 1;
          saved.current[id] = option;
          conflicts = 0;
        } catch (failure) {
          if (failure instanceof ApiError && failure.code === "STALE_REVISION" && conflicts++ < 3) {
            const fresh = await persistence<PublicState>(`/api/state?slug=${encodeURIComponent(slug)}`, undefined, "GET");
            revisions.current[id] = fresh.profile?.revisions[id] ?? 0;
            saved.current[id] = fresh.profile?.answers[id];
            continue;
          }
          if (mounted.current) { setError("답변을 저장하지 못했어요. 연결을 확인하고 다시 저장해주세요."); setSaveState("저장이 필요해요"); }
          throw failure;
        }
      }
    })().finally(() => {
      jobs.current.delete(id);
      if (mounted.current && Object.keys(desired.current).every((key) => desired.current[key] === saved.current[key])) setSaveState("답변이 저장되었어요");
    });
    jobs.current.set(id, job);
    return job;
  };

  const choose = (id: string, option: Option) => {
    desired.current[id] = option;
    setAnswers((current) => ({ ...current, [id]: option })); setSaveState("저장하고 있어요…"); setError(null);
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => void save(id).catch(() => {}), 300));
  };
  const flush = async () => {
    timers.current.forEach(clearTimeout); timers.current.clear();
    await Promise.all(Object.keys(desired.current).map(save));
  };
  const submit = async () => {
    setSubmitting(true); setError(null);
    try { await flush(); await send("/api/profile/submit"); onDone?.(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "잠시 후 다시 시도해주세요."); }
    finally { setSubmitting(false); }
  };
  const count = Object.keys(answers).length;
  return <>
    <SectionTitle label="My Data" title="나의 Data 만들기" description="20개의 질문에서 나와 더 가까운 답을 골라주세요. 이 응답이 Game의 Data가 됩니다." />
    <div className="profile-progress"><div><strong>{count} / 20</strong><span className="small muted" aria-live="polite">{saveState}</span></div><progress max={20} value={count} aria-label="프로필 입력 진행" /></div>
    <div className="profile-list">{questions.map((question, index) => <fieldset key={question.id} className="question-card" disabled={submitting || !state.profile?.editable}>
      <legend><span className="question-number">{String(index + 1).padStart(2, "0")}</span><span>{question.category}</span></legend>
      <div className="option-grid">{(["A", "B"] as const).map((option) => <label key={option} className={`profile-option ${answers[question.id] === option ? "selected" : ""}`}>
        <input type="radio" name={question.id} value={option} checked={answers[question.id] === option} onChange={() => choose(question.id, option)} /><span className="option-letter">{option}</span><span>{question.options[option]}</span><span className="option-tick" aria-hidden="true">{answers[question.id] === option ? "✓" : ""}</span>
      </label>)}</div>
    </fieldset>)}</div>
    <div className="sticky-action">
      {error && <p role="alert" className="error-message">{error} <button className="text-button" onClick={() => { setError(null); void flush().catch(() => {}); }}>다시 저장</button></p>}
      <button className="button primary full" disabled={count !== 20 || submitting} onClick={() => void submit()}>{submitting ? "등록하고 있어요…" : "프로필 등록 완료"}<span aria-hidden="true">→</span></button>
      {count < 20 && <p className="small muted center">모든 질문에 답하면 다음 단계로 갈 수 있어요.</p>}
      {!state.profile?.complete && <button className="text-button small" disabled={submitting} onClick={() => void send("/api/session/release").catch(() => {})}>이름을 잘못 골랐어요</button>}
    </div>
  </>;
}
