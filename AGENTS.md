# KANT Mingling 작업 지침

- 먼저 README, docs/architecture.md, docs/install-agent.md를 읽는다.
- main은 검증된 게임 기준 버전이다. UI·확장 작업은 develop 또는 그 하위 작업 브랜치에서 한다.
- Next.js의 설치 버전 문서는 node_modules/next/dist/docs/에 있다. 관련 가이드를 읽고 변경한다.
- `.env*`의 내용을 읽거나 출력하지 않는다. 스크립트가 런타임에 로드하는 것은 허용한다. 키·쿠키·운영진 코드·실제 명단·프로필 답변을 로그나 커밋에 남기지 않는다.
- 공개 전 정답·Noise 여부·원래 답변·RNG 정보를 DTO에 넣지 않는다. 일반 카드 본문과 질문 원문은 수신자에게만 전달한다. 사용자 승인(2026-09-22)에 따라 Noise 추리가 가능한 현재 Turn Lead에게만 별도 guess.cards로 지금까지 전달한 카드의 질문·표시 답변을 제공한다. 정답·실제/Noise 구분·원래 답은 포함하지 않는다. 관리자라는 이유만으로 이 예외를 적용하지 않는다.
- 역할·권한·게임 상태는 서버가 결정한다. UI 개편은 데이터 전달 경계와 기존 명령 계약을 유지한다.
- 게임 규칙과 콘텐츠를 임의 변경하지 않는다. 질문 원문은 docs/profile-questions.md §2·§4와 src/content/questions.v2.json이 일치해야 한다.
- 사용자 요청의 범위를 확인한다. 운영 DB 쓰기·운영 배포·실제 명단과 코드 발급은 해당 작업에 대한 사용자의 명시적인 승인이 필요하다. 이미 승인받은 작업은 재확인하지 않는다.
- 검증은 lint, typecheck, 단위 테스트, 콘텐츠 검사, build를 기본으로 한다. DB 변경은 개발 환경의 관련 통합 테스트를 실행한다.
- 기존 migration은 수정하지 않고 새 migration을 추가한다. 개발 DB 검사는 endpoint 고정값과 app_environment 표지를 함께 검증하며 우회하지 않는다.
- 완료 보고에는 변경·검증·남은 제한을 기록한다. 검증하지 않은 규모나 브라우저 지원을 단정하지 않는다.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
