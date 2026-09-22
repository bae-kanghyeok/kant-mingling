"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicState } from "@/lib/contracts";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

export type ApiResult = { ok: boolean; correct?: boolean; revision?: number; data?: Record<string, unknown> };
export type SendAction = (path: string, body?: Record<string, unknown>, method?: string) => Promise<ApiResult>;

export async function requestJson<T>(path: string, body?: Record<string, unknown>, method = "POST"): Promise<T> {
  const response = await fetch(path, {
    method, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(12000),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new ApiError(result.error?.code ?? "REQUEST_FAILED", result.error?.message ?? "잠시 후 다시 시도해주세요.", response.status);
  }
  return result as T;
}

export function useMingleState(slug: string) {
  const [state, setState] = useState<PublicState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<number | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef<PublicState | null>(null);
  const lastSuccess = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  const sent = useRef(0);
  const applied = useRef(0);

  const refresh = useCallback((): Promise<void> => {
    const currentGeneration = generation.current;
    const task = chain.current.catch(() => {}).then(async () => {
      if (currentGeneration !== generation.current) return;
      const sequence = ++sent.current;
      const next = await requestJson<PublicState>(`/api/state?slug=${encodeURIComponent(slug)}`, undefined, "GET");
      if (currentGeneration !== generation.current || sequence < applied.current) return;
      applied.current = sequence;
      stateRef.current = next;
      lastSuccess.current = Date.now();
      setState(next); setDisconnected(false); setTerminal(null);
      if (next.poll.needsSync) await requestJson("/api/state/sync", { slug });
    });
    chain.current = task;
    return task;
  }, [slug]);

  useEffect(() => {
    const activeGeneration = ++generation.current;
    let stopped = false;
    let polling = false;
    let pollAgain = false;
    let timer: ReturnType<typeof setTimeout>;
    let failures = 0;
    const poll = async () => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      if (polling) { pollAgain = true; return; }
      polling = true;
      try {
        await refresh();
        failures = 0;
      } catch (failure) {
        failures++;
        if (failure instanceof ApiError && [404, 410].includes(failure.status)) setTerminal(failure.status);
        if (failure instanceof ApiError && failure.status === 401) {
          try { await requestJson("/api/session/bootstrap", { slug }); await refresh(); failures = 0; } catch { /* Next poll retries. */ }
        }
      }
      if (!stopped && !document.hidden) {
        const interval = failures ? Math.min(10000, 2000 * 2 ** (failures - 1)) : (stateRef.current?.poll.intervalMs ?? 5000);
        timer = setTimeout(poll, pollAgain ? 0 : interval + Math.random() * 200);
      }
      polling = false; pollAgain = false;
    };
    const wake = () => { if (!document.hidden && !stopped) void poll(); else clearTimeout(timer); };
    const warning = setInterval(() => {
      if (!document.hidden && lastSuccess.current && Date.now() - lastSuccess.current > 8000) setDisconnected(true);
    }, 1000);
    const start = async () => {
      lastSuccess.current = Date.now();
      try { await requestJson("/api/session/bootstrap", { slug }); }
      catch (failure) {
        if (failure instanceof ApiError && [404, 410].includes(failure.status)) setTerminal(failure.status);
      }
      if (!stopped) void poll();
    };
    void start();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake); window.addEventListener("online", wake);
    return () => {
      stopped = true; generation.current = activeGeneration + 1; clearTimeout(timer); clearInterval(warning);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake); window.removeEventListener("online", wake);
    };
  }, [slug, refresh]);

  const send: SendAction = useCallback(async (path, body = {}, method = "POST") => {
    setBusy(true); setError(null);
    try {
      const result = await requestJson<ApiResult>(path, { slug, requestId: crypto.randomUUID(), ...body }, method);
      await refresh();
      return result;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "연결을 다시 확인해주세요.";
      setError(message);
      await refresh().catch(() => {});
      throw failure;
    } finally { setBusy(false); }
  }, [slug, refresh]);

  return { state, error, terminal, disconnected, busy, send, refresh, clearError: () => setError(null) };
}
