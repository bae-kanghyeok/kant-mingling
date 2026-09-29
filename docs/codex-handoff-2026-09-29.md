# KANT Mingling 인계 — 2026-09-29

기준일: 2026-09-29. 이 문서가 [2026-09-23 인계](home-codex-handoff.md)보다 우선한다. 운영 식별값(배포·프로젝트 ID, 행사 링크, 운영진 코드)은 공개 저장소에 두지 않는다. 담당자 PC의 로컬 인계 문서(`*.local.md`, Git 제외)에 있다.

## 1. 현재 상태

- **브랜치:** `main`과 `develop`이 같은 commit이다. GM 모드가 `main`에도 들어갔다. 이후 작업은 `develop` 또는 그 하위 브랜치에서 한다.
- **운영:** Vercel 프로젝트 `kant-mingling-live`와 Neon 운영 프로젝트 `kant-mingling-live`. 이전 `whos-data` 프로젝트·Preview는 이번 행사 대상이 아니다. 두 문서가 다르면 이 문서가 우선이다.
- **Vercel Git 연동 없음.** push는 GitHub Actions `Checks`(lint·typecheck·단위·콘텐츠·build)만 실행한다. 운영 반영은 아래 CLI 배포로 한다.

## 2. 2026-09-29 변경

| commit | 내용 |
| --- | --- |
| `914948e` | 폴링 1회의 DB 조회를 그 사람의 화면(DTO)에 필요한 행으로 축소([snapshot.ts](../src/server/db/snapshot.ts)). SQL 한 문장과 `EventSnapshot` 형태는 그대로. 종료 뒤 폴링 30초. |
| `10ef542` | 프로필 20문항 `2026-09-29.1`. 이전 대비 Q13 '추석 공부/휴식' 삭제, Q13·Q14 한 칸씩 당김, Q15 '회의 시작' 추가. 분류 표시 없음. [원문](profile-questions.md) |
| 이 문서의 commit | T36 21명(학생 18·GM 3)·조별 3명 이동 사례 추가, 인계 문서 갱신 |

폴링 조회량은 21명 GM 기준 학생 1회 약 117~136KB에서 약 25~35KB로 줄었다. [T37](../tests/integration/t37-viewer-snapshot.test.ts)은 이전 전체 조회를 [테스트 오라클](../tests/integration/full-snapshot-oracle.ts)로 두고, 21명 GM 진행의 단계마다 모든 참가자의 화면 데이터가 같은지와 크기 예산을 검사한다. 21명이 모두 화면을 켜 두면 DB 전송량은 시간당 약 0.7~0.9GB로 추정한다(측정값 아님).

## 3. 검증 기록 (2026-09-29, 회사 PC·개발 DB)

- lint, typecheck, 단위 12파일/91개, 콘텐츠 20문항/60문구, GitHub Actions 통과.
- 전체 DB suite 58/58. T33 두 사례는 기본 30초 제한에 걸려 단독으로 180초 제한을 주어 다시 실행해 6/6 통과했다.
- 로컬 21인 HTTP 확인 1,253/1,253, 5xx 0. 모든 판을 강제 공개로 끝낸다.
- 설계와 diff는 Codex 교차 검토를 받아 지적 사항을 반영했다.
- 미검증: 운영 환경 응답 시간, 실물 휴대폰·현장 Wi-Fi, 동시 부하, Noise 선택 화면의 분류 없는 모양(코드로만 확인).

## 4. 운영 배포 방법

1. 배포할 commit을 새 폴더에 clone한다. 로컬 변경·환경파일이 섞이지 않게 한다.
2. Vercel CLI `59.23.2` 로그인은 담당자가 직접 한다. 한글 PC 이름이면 [hostname 보정](../scripts/vercel-ascii-hostname.cjs)을 `NODE_OPTIONS=--require …`로 그 명령에만 적용한다.
3. `VERCEL_ORG_ID`·`VERCEL_PROJECT_ID`에 로컬 인계 문서의 `kant-mingling-live` 값을 넣고 `vercel deploy --prod`를 실행한다. `vercel link`나 `env pull`은 개발용 `.env.local`을 만들거나 덮어쓸 수 있으므로 쓰지 않는다.
4. 운영 `/api/health`의 app·database가 ok인지 확인한다. 되돌릴 때는 Vercel에서 이전 Production 배포를 다시 승격한다.

운영 배포·운영 DB 쓰기·실명 명단·운영진 코드는 그때마다 사용자의 명시적 승인이 필요하다.

## 5. 주의

- 질문 문구를 바꾸면 이미 저장된 답(ID·A/B)이 새 문구로 읽힌다(`content_version` 비교 없음). 새 문항은 답변이 없는 새 행사에서 시작한다.
- 새 운영 DB로 옮길 때는 다음 순서로 진행하고, 단계마다 승인을 받는다.
  1. production marker와 migration 001~003
  2. Vercel Production 환경변수 교체와 재배포
  3. 실명 명단 seed(명단 파일은 로컬 전용)와 호스트 지정
  4. 운영진 코드 발급(담당자 직접)
- DB 테스트·합성 리허설은 개발 DB에서만 실행한다. 운영 행사를 테스트 fixture로 쓰지 않는다.

## 6. 새 Codex에게 전달할 프롬프트

```text
KANT Mingling을 이어서 작업해줘. 저장소: https://github.com/bae-kanghyeok/kant-mingling (main = develop, 작업은 develop)
AGENTS.md → docs/codex-handoff-2026-09-29.md → README.md → docs/architecture.md → docs/install-agent.md → docs/gm-mode.md 순서로 읽어줘.
담당자 PC에 docs/claude-handoff-2026-09-29.local.md가 있으면 운영 식별값과 오늘 상태를 거기서 확인해줘(내용을 채팅·Git에 옮기지 마).
.env 파일은 열거나 출력하지 말고, 로그인은 내가 직접 해.
운영 배포·운영 DB 쓰기·실명 명단·운영진 코드는 매번 내 승인을 받아줘. 기존 행사를 테스트에 쓰지 마.
기존 checkout에 미추적 감사 자료가 있으면 보존해줘. reset/clean/강제 덮어쓰기를 하지 마.
확인 결과와 꼭 필요한 내 단계만 한국어로 짧게 알려줘.
```
