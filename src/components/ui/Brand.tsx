import Image from "next/image";

export function Rtan({ size = 36, className = "" }: { size?: number; className?: string }) {
  return <Image className={`brand-logo ${className}`} src="/brand/rtan.png" width={size} height={Math.round(size * 134 / 128)} alt="" unoptimized />;
}

export function Brand() {
  return <div className="brand"><Rtan /><div className="brand-lockup">KANT<span>Mingling</span></div></div>;
}

export function WelcomeVisual() {
  return <div className="welcome-visual" aria-hidden="true">
    <span className="visual-orbit orbit-one" /><span className="visual-orbit orbit-two" />
    <span className="visual-chip chip-top">A little Data</span>
    <div className="visual-card"><span className="visual-card-label">Meet your Data Owner</span><Rtan size={128} /><strong>Who am I?</strong><span className="visual-card-dots">● ● ●</span></div>
    <span className="visual-chip chip-bottom">A new connection ↗</span>
  </div>;
}

export function WelcomeSteps() {
  return <ol className="welcome-steps"><li><span>01</span><strong>나를 소개하고</strong><p>가벼운 질문에 답해요</p></li><li><span>02</span><strong>서로 추리하고</strong><p>흩어진 Data를 모아요</p></li><li><span>03</span><strong>이야기로 연결돼요</strong><p>선택한 이유를 나눠요</p></li></ol>;
}
