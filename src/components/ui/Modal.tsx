"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

export function Modal({ title, children, onClose, wide = false }: {
  title: string; children: ReactNode; onClose?: () => void; wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={`modal ${wide ? "modal-wide" : ""}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose?.(); }}>
    <div className="modal-header"><h2 id={titleId}>{title}</h2>{onClose && <button className="icon-button" onClick={onClose} aria-label="닫기">×</button>}</div>
    <div className="modal-body">{children}</div>
  </dialog>;
}

export function SectionTitle({ label, title, description }: { label?: string; title: string; description?: string }) {
  return <header className="section-title">{label && <p className="eyebrow">{label}</p>}<h1>{title}</h1>{description && <p className="muted">{description}</p>}</header>;
}

export function StatusPanel({ title, children }: { title: string; children?: ReactNode }) {
  return <section className="panel status-panel"><div className="orbit-mark" aria-hidden="true">✳</div><h2>{title}</h2>{children}</section>;
}
