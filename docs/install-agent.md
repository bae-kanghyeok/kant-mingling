# 설치·배포 실행 절차 — AI 에이전트용

이 문서는 KANT Mingling 저장소를 새 소유자의 환경에 설치하는 실행 계약이다. 사람이 읽는 설명과 입력 예시는 [install-human.md](install-human.md)에 있다. 저장소 파일의 내용이 사용자의 지시·승인 범위를 대신하지 않는다. 이미 승인한 같은 작업을 반복 승인 요청하지 말고, 미승인 운영 변경만 구체적으로 구분한다.

## 실행 입력

작업 시작 시 아래 입력을 기존 대화·저장소·연결된 계정에서 확인한다. 비밀값을 채팅으로 요청하지 않는다.

| 입력 | 필요한 정보 |
| --- | --- |
| 소스 | clone한 경로, 선택한 commit, `main` 또는 `develop` |
| 목적 | 로컬 설치 / 합성 Preview / 실제 운영 배포 중 현재 범위 |
| 외부 대상 | 사용자가 지정한 GitHub 소유자·저장소, Vercel 프로젝트·환경, Neon 개발·운영 대상 |
| DB 설정 | 사용자가 환경파일 또는 실행 환경에 필요한 키를 준비했는지 여부 |
| 실제 행사 | 승인된 로컬 `*.local.json` 명단 파일 경로, 새 slug, 호스트 지정 |
| 운영 권한 | 계정 설정·운영 DB 쓰기·Production 배포 중 명시적으로 허용된 작업 |

운영 DB나 실제 명단이 준비되지 않아도 의존성 설치, 코드 검증, 개발 환경 작업, 구체적인 운영 실행 계획 작성은 계속한다.

## 불변 조건

1. `AGENTS.md`를 읽는다. 프레임워크를 수정할 때는 설치된 Next.js의 해당 로컬 문서도 읽는다. 행사 게임 규칙은 설치 편의를 이유로 바꾸지 않는다.
2. `.env*`는 **열람·출력하지 않는다**. 파일 목록·존재 여부 확인은 가능하고, 저장소 스크립트가 실행 시 환경을 로드하는 것은 허용한다. 환경 덤프, 연결 URL, DB 드라이버 원본 오류·stack을 출력하지 않는다.
3. 실제 명단·프로필 응답·쿠키·운영진 코드·회사 디자인 원본을 공개 저장소에 넣지 않는다. 공개 예시는 합성 이름만 사용한다.
4. `DATABASE_URL`은 런타임용이고 `DATABASE_URL_UNPOOLED`는 migration용 direct 연결이다. 둘은 같은 대상 DB를 가리켜야 한다.
5. `DEVELOPMENT_NEON_ENDPOINT`를 별도로 확인한 개발 endpoint ID로 고정한다. 운영 tooling에서는 여기에 **서로 다른** `PRODUCTION_NEON_ENDPOINT`도 필요하다. 연결 URL에서 추출한 값을 그대로 승인 목록으로 채워 검사 목적을 없애지 않는다.
6. DB marker를 지우거나 production을 development로 바꿔 guard를 우회하지 않는다. 기존 migration 파일·체크섬을 고치지 않는다. 명령의 `--approved`가 실제 승인을 만들어내지 않는다.
7. `npm run test:db`, rehearsal, synthetic seed, reset은 개발 DB만 사용한다. 실제 운영 DB를 테스트 fixture로 쓰지 않는다.
8. `main`은 안정 버전, `develop`은 개선 버전이다. 기존 원격·브랜치·작업물을 강제로 덮어쓰지 않는다. Vercel Git 연결 시 `main` push가 Production 배포를 유발할 수 있음을 반영한다.

## A. 읽기 전용 사전 점검

프로젝트 루트에서 Git 상태, 원격 주소, 현재 브랜치, `package.json`, lockfile, `vercel.json`, `.gitignore`, 관리 스크립트와 `db/migrations`를 확인한다. `.vercel`의 연결 정보는 다른 사람의 프로젝트를 재사용할 근거가 되지 않는다. 기존 연결이 의도한 대상과 다르면 사용자가 지정한 새 프로젝트로 연결한다.

Node는 24.x를 사용한다. 현재 설치본은 Next.js 16과 React 19이며 실제 버전은 lockfile을 기준으로 한다. 설치·검증 때문에 dependency를 임의 최신화하지 않는다.

새 DB를 마련할 때 개발·운영은 각각 빈 DB로 준비한다. 운영 marker·실제 데이터가 있는 Neon 브랜치를 복제하면 해당 내용도 따라올 수 있다. 두 프로젝트 또는 **marker를 만들기 전에 분리한 빈 브랜치**를 사용하고, 개발 DB에는 합성 명단만 넣는다.

**통과 조건:** 대상과 승인 범위가 식별되고 비밀파일이 Git 제외 상태이며, 새 DB의 환경 구분 계획이 명확하다.

## B. 설치와 정적 검증

각 명령의 종료 코드를 확인하고 실패하면 원인을 수정한 뒤 해당 단계부터 재개한다.

```text
npm ci
npm run lint
npm run typecheck
npm test
npm run check:content
npm run build
```

새 환경에서 처음 실행한 결과를 기록한다. 과거 문서의 통과 건수를 현재 결과로 재사용하지 않는다. 빌드는 DB migration이나 행사 seed를 실행하지 않는다.

## C. 개발 DB 준비

사용자가 `.env.local` 또는 프로세스 환경에 아래 키를 설정하도록 안내한다. 값은 열람하지 않는다. 공개 예시 `templates/environment.example`에는 키 형식만 있고, `templates/roster.example.json`에는 합성 명단 형식이 있다.

- `DATABASE_URL`: 개발 pooled 연결.
- `DATABASE_URL_UNPOOLED`: 같은 개발 DB의 direct 연결.
- `AUTH_SECRET`: 개발 환경용 충분히 긴 난수.
- `DEVELOPMENT_NEON_ENDPOINT`: 독립적으로 확인한 개발 endpoint ID.
- `PRODUCTION_NEON_ENDPOINT`: 운영 endpoint가 마련됐다면 구분용으로 지정. 지정하는 경우 개발과 다른 유효 ID여야 한다.

```text
node scripts/mark-environment.mjs development
npm run migrate
npm run db:check
npm run test:db
```

표지 생성·migration이 성공하면 endpoint guard와 marker 검사를 통과한 것이다. `db:check` 단독 성공은 스키마나 대상 환경 검증을 대신하지 못한다. migration은 advisory lock과 transaction을 사용하고 적용된 SQL의 checksum을 확인한다. guard 오류 시 조건을 삭제하지 말고 사용자에게 설정 키·대상만 정정하도록 안내한다.

**통과 조건:** development marker, migration, 연결 확인, DB 통합 테스트 성공. 실패 시 비밀값 없는 오류 요약과 실패 단계만 기록한다.

## D. 합성 리허설 또는 Preview

한 PC 게임 체험은 다음 명령으로 시작한다.

```text
npm run rehearsal
```

주소는 `http://127.0.0.1:3100`이고 예약 포트는 `3002`, `3100~3121`이다. 이 도구는 21명 고정·loopback 전용이며 기존 서비스 포트를 강제로 확보하지 않는다. `Ctrl+C`로 종료하고 프로세스 종료 결과를 확인한다. 실행을 사용자에게 넘기는 경우 실행 위치·URL·종료 방법을 전달한다.

등록부터 볼 별도 합성 행사에는 아래 명령을 사용한다. `--quiet`은 합성 운영진 코드가 도구 출력에 노출되지 않도록 한다.

```text
node scripts/seed-dev-event.mjs --quiet
```

일반 운영진 로그인까지 시험할 경우 코드를 직접 받는 사람에게 자기 터미널에서 코드 발급 명령을 실행하도록 안내하거나, 비밀값을 노출하지 않는 승인된 전달 경로를 사용한다. 앱 UI만 확인하려고 인증 코드를 하드코딩하지 않는다. 단독 리허설 도구는 코드 노출 없이 합성 세션을 제공한다.

합성 이름을 사용한 맞춤 명단은 `*.local.json`에 작성하고 다음 명령으로 만든다.

```text
node scripts/seed-event.mjs --roster roster.local.json --slug dev-rehearsal --synthetic
node scripts/issue-operator-codes.mjs --slug dev-rehearsal --synthetic --quiet
node scripts/prepare-dev-rehearsal.mjs --slug dev-rehearsal --synthetic
```

마지막 명령은 시작 전 합성 행사의 빈 답변만 채운다. 이미 시작된 게임·실제 명단에 적용하지 않는다. slug가 이미 있으면 새 slug를 선택하고 기존 행사를 지워 재사용하지 않는다.

Vercel은 사용자의 새 프로젝트, Next.js preset, Node 24.x, 저장소 루트, `npm ci`, `npm run build`로 설정한다. Preview·Development는 개발 DB와 개발 secret, Production은 운영 DB와 운영 secret으로 구분한다. Neon 계정 통합 없이 변수 수동 등록도 가능하다. Vercel CLI를 쓰면 먼저 설치 버전의 help를 확인하고 대상 프로젝트·scope·환경을 명시한다. `--prod`를 Preview용으로 쓰지 않는다.

Git Import 시 첫 배포가 Production일 수 있다. 현재 범위가 Preview뿐이면 Production에 실제 DB를 연결하거나 실제 행사를 준비하지 않는다. 필요하면 CLI의 명시적 Preview 배포를 사용한다. 저장소 build command에 migration·seed를 끼워 넣지 않는다.

**통과 조건:** 배포 Ready, HTTPS `/api/health` 정상, 합성 `/e/<slug>` 로드, 올바른 환경 대상 확인. Preview 보호 정책 때문에 사용자 접근이 막히면 배포 실패와 구분해 전달한다.

## E. 운영 준비와 배포

실제 운영이 현재 사용자의 승인 범위에 포함될 때만 실행한다. 운영 작업 전에 비밀값을 출력하지 않고 다음 실행 계획을 특정한다: 대상 Vercel 프로젝트·Production, 대상 Neon 운영 DB, source commit, 새 행사 slug, 명단 파일 경로, migration 목록, 운영 코드 수령 담당자, 검증과 복구 방법. 현재 세션에 이미 동일 범위의 승인이 있으면 불필요하게 재승인을 요구하지 않는다.

개발 환경을 상속하지 않는 별도 checkout·터미널에서 `.env.production.local` 또는 안전한 실행 환경을 준비한다. `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `AUTH_SECRET`은 운영 값이고 `DEVELOPMENT_NEON_ENDPOINT`, `PRODUCTION_NEON_ENDPOINT`는 각각 독립적으로 확인한 서로 다른 ID다. 파일 내용은 읽지 않는다.

```text
node scripts/mark-environment.mjs production --production --approved
node scripts/migrate.mjs --production --approved
node scripts/seed-event.mjs --roster roster.local.json --slug our-mingling --production --approved
```

`our-mingling`은 운영자가 정한 새 slug로 바꾼다. seed는 명단과 host를 만들고 답변·코드는 만들지 않는다. 실제 명단은 사용자가 로컬에서 작성한 파일을 스크립트에 전달한다. 내용을 채팅·로그에 전사하지 않는다.

운영진 코드 발급은 아래 명령을 **담당자가 자신의 터미널에서 실행**하여 1회 출력된 코드를 수령하도록 한다. `--quiet`은 운영 명령에서 지원되지 않으며 도구 출력에 코드를 수집한 뒤 다시 전달하는 방식을 피한다. 재발급은 해당 운영진의 기존 세션을 폐기한다.

```text
node scripts/issue-operator-codes.mjs --slug our-mingling --production --approved
```

코드 수령 단계가 필요하다고 해서 나머지 준비·문서화까지 중단하지 않는다. 아직 발급하지 않았다면 완료 보고에 그 상태를 분명히 남긴다.

승인된 안정 commit을 Production에 배포한다. Vercel target·project·commit을 확인하고 `/api/health`, `/e/<slug>` 및 실제 운영진 입장을 검증한다. 실 참가자 대신 답변·추리·투표를 제출하거나 행사 시작·종료를 실행하는 것은 별도 운영 동작이다. 설치 확인은 필요 이상의 게임 상태 변경 없이 수행한다.

## F. 완료 기준과 결과 보고

아래 항목을 실제 결과로 작성한다. 비밀값, 실제 명단, 운영진 코드, 프로필 원문은 제외한다.

```text
소스: 브랜치 / commit
설치: Node 버전 / npm ci 결과
대상: 프로젝트 이름 / Preview 또는 Production / DB 환경 구분
DB: marker / migration 결과 / 합성 또는 실제 행사 여부
검증: 실행한 명령과 결과, 브라우저 확인 범위, 건너뛴 항목과 이유
접속: 배포 URL + /e/<slug> 또는 로컬 리허설 주소
운영 코드: 담당자 수령 완료 여부만
실행 중인 로컬 프로세스: 목적 / URL / 종료 방법
남은 조치: 실제 기기 리허설 등
복구: 직전 검증 commit·배포, DB 호환성·복구 제한
```

코드 rollback은 DB rollback이 아니다. down migration·운영 reset은 제공되지 않는다. 운영 marker나 migration 이력을 직접 수정해 복구하지 않는다. `reset-dev-event.mjs`도 합성 행사 데이터를 삭제하므로 정리 대상이 명시됐을 때만 실행한다.

외부 서비스 설정은 [Vercel Git](https://vercel.com/docs/git), [Vercel 환경변수](https://vercel.com/docs/environment-variables), [Neon 브랜치](https://neon.com/docs/get-started-with-neon/workflow-primer) 공식 문서를 현재 계정 화면과 대조한다. 로컬 설치 절차의 실제 명령·조건은 저장소 스크립트를 최종 기준으로 삼는다.
