# 집의 새 PC·새 Codex를 위한 KANT Mingling 인계

기준일: 2026-09-23. 이전 대화, 회사 PC, 비공개 첨부파일이 없어도 최신 소스를 받아 작업을 이어갈 수 있도록 작성했다. 상태와 검증 수치는 이 날짜의 기록이며, 집에서 접속할 때 Git과 서비스의 현재 상태를 다시 확인한다.

**최신 GM 구현은 `develop`에 있다. GitHub 기본 브랜치 `main`에는 아직 합치지 않았다.** 저장소는 [bae-kanghyeok/kant-mingling](https://github.com/bae-kanghyeok/kant-mingling/tree/develop)이다. 제품 변경 기준 commit은 `7acb834`, 후속 검증 문서 기준은 `bc12d26`이다. 이 인계 문서를 포함한 이후 문서 commit도 함께 받는다.

## 1. 새 Codex에게 그대로 전달할 프롬프트

```text
KANT Mingling 프로젝트를 회사 PC에서 집 PC로 인계받아 이어서 작업해줘.
저장소: https://github.com/bae-kanghyeok/kant-mingling
작업 브랜치: develop (기본 main은 이전 기준 버전)

기존 checkout이 있으면 먼저 경로·Git 상태·브랜치·원격을 확인하고 내 작업을 보존해줘.
없으면 내가 연 작업 폴더 아래에 develop을 clone해줘.
AGENTS.md → docs/home-codex-handoff.md → README.md → docs/architecture.md →
docs/install-agent.md → docs/gm-mode.md → docs/gm-validation-2026-09-23.md 순서로 읽어줘.

우선 Node 24.x와 npm ci, DB 없는 기본 검사, /design-preview로 인계를 확인해줘.
내 회사 PC의 절대 경로·.env·브라우저 로그인·Codex 도구가 집에도 있다고 가정하지 마.
DB 게임이 필요하면 인계 문서의 기존 whos-data Preview 개발 환경 연결 절차를 따라줘.
환경파일과 인증값은 열거나 출력하지 말고, 새 로그인은 내가 직접 하도록 안내해줘.
기존 사람용 리허설은 보존하고 자동 감사는 별도 고유 slug의 합성 행사로 진행해줘.
seed:dev와 npm run rehearsal은 classic 21인 도구이므로 GM 검증용으로 혼동하지 마.

GM도 참가자이고 공개 전 정답을 볼 수 없어. GM이 대화 뒤 다음 단서·추리를 열며,
다음 판 Noise 수는 최대 개수이고 일찍 맞혀도 돼. 판 수와 자리 회차는 유동적이야.
검증되지 않은 실제 사람의 재미·실물 휴대폰·GM 21인 검증을 완료로 보고하지 마.
main/Production은 유지하고 develop 또는 하위 브랜치에서 작업해줘.
시작 결과와 남은 우선순위를 짧게 알려준 뒤 내가 추가한 작업을 이어가줘.
```

이 프롬프트는 인계·설치 확인용이다. 후속 수정 요구가 있으면 마지막 줄 뒤에 덧붙인다. 서비스 계정 연결이 끝나지 않아도 소스 읽기와 DB 없는 검증은 진행할 수 있다.

## 2. 왜 GM 방식으로 바뀌었나

처음에는 프로필 단서로 같은 조의 사람을 맞히는 게임을 만들었다. 매니저 실플레이에서 ‘정답을 빨리 맞히기’에 집중하고, 후보에서 제외된 사람의 대화 기회가 줄어든다는 피드백이 나왔다. 질문을 고르는 경험 자체는 재미있다는 평가가 있었다.

이를 반영해 **조 운영진이 GM으로 대화를 진행하고 리모컨으로 다음 행동을 여는 방식**을 추가했다. 목표는 빠른 정답이나 많은 판을 끝내는 것이 아니라, 질문을 매개로 서로의 선택·이유·경험을 나누는 것이다. 기존 게임은 classic으로 보존하고 새 행사에 `gameplayMode: "gm"`을 지정한다. 기존 행사를 자동 변환하지 않는다.

확정된 운영 계약:

- 조마다 GM 1명, 전체 총괄 GM 1명 겸임. GM도 20문항을 작성하고 Owner 후보와 투표에 참여한다.
- GM은 자기 조의 다음 단서, 추리 열기·닫기, Ensemble 투표·토론, 다음 판을 제어한다. 추리는 현재 Turn Lead가 제출한다.
- GM도 공개 전 정답·Noise 위치·원래 답·선택 진단 정보를 볼 수 없다. 일반 카드 본문은 수신자에게만 전달한다. 추리 가능한 현재 Turn Lead에게만 `guess.cards`로 팀의 표시 질문·답을 제공한다.
- 조의 전체 첫 판은 Noise 0·Ground Truth 끔, 단서 1개부터 추리 가능. 이후 판은 최소 단서 3개, Noise 최대 0~5와 Ground Truth 사용 여부를 GM이 설정한다. **최대 2개라도 1개만 나온 때 맞히면 끝난다.**
- 새 단서·오답·진행권 변경 등으로 기존 추리 허가가 닫힌다. 서버가 권한과 상태를 다시 검사하며 새로고침으로 우회되지 않는다.
- 각 조 진행 속도는 독립적이다. 고정 3판·9판 완주나 자동 시간 종료를 GM 모드에 적용하지 않는다.
- 총괄 이동 요청 → 현재 판·후속 대화 마무리 → 각 조 준비 완료 → 전 조 준비 후 새 배정 공개 → 각 GM이 착석 확인 후 시작한다. 이동 요청 뒤 새 판 시작은 막힌다.
- 기본 3조 행사는 학생 3명씩 이동하고 GM은 고정이다. 한 조 4~6인 리허설은 이동 인원 0명이다.
- 담당 GM이 결석했거나 프로필을 완료하지 않으면 서버가 판 시작을 거절한다.
- 점수·순위는 없다. 프로필 카테고리 표시는 없앴고, 질문 원문+선택 답, 내용이 있는 세로 Noise 선택지, 튜토리얼 수동 이전·다음을 유지한다.

세부 진행 멘트와 예외는 [GM 운영 안내](gm-mode.md), 사람 테스트 순서는 [GM 4~6인 리허설](gm-human-rehearsal.md)을 따른다. 질문 20개는 이번 GM 개선에서 바꾸지 않았다. 최초 지시서·이전 classic 문서가 최신 GM 결정을 덮어쓰지 않도록 구분한다.

## 3. 소스 받기와 DB 없이 확인하기

Git, Node.js **24.x**, npm이 필요하다. 잠금 파일 기준으로 설치하며 dependency를 임의 최신화하지 않는다. 최초 설치와 Next 빌드의 Google 폰트 다운로드에는 네트워크가 필요하다.

새 폴더에서:

```sh
git clone --branch develop https://github.com/bae-kanghyeok/kant-mingling.git
cd kant-mingling
git status --short
git log -3 --oneline
node --version
npm ci
npm run lint
npm run typecheck
npm test
npm run check:content
npm run build
```

기존 checkout은 먼저 변경사항을 확인한다. 정리된 checkout에서 `git fetch origin`, `git switch develop`, `git pull --ff-only origin develop`으로 갱신한다. 충돌이나 미커밋 변경이 있으면 reset/clean으로 지우지 않는다. 공개 clone은 로그인 없이 가능하지만 push는 집 PC의 GitHub 인증이 필요하다.

DB 연결은 필요한 서버 동작에서 생성하도록 되어 있어 위 기본 검사는 DB 설정 없이 실행할 수 있는 구조다. 이번 인계 문서 작성 때 새 PC에서 무환경 설치를 재현한 것은 아니므로, 실제 집 PC 실행 결과를 별도로 기록한다.

화면 검토:

```sh
npm run dev -- --hostname 127.0.0.1 --port 3300
```

[로컬 화면 둘러보기](http://127.0.0.1:3300/design-preview)에서 합성 39개 화면(기존 33+GM 6)을 확인한다. DB를 변경하지 않는다. 종료는 해당 터미널의 `Ctrl+C`. `/design-preview`는 개발 서버 전용이며 `npm start`나 Vercel Production 빌드에서는 404가 정상이다. `/e/<slug>`의 실제 게임에는 DB와 인증 설정이 필요하다.

## 4. 현재 사용 중인 원격 대상

아래는 기존 소유자의 집 PC 인계를 위한 식별 정보다. 다른 사람이 새로 설치할 때는 [설치 안내](install-human.md)에 따라 자기 프로젝트를 만든다. 환경변수·접속 문자열·인증 코드는 이 문서에 포함하지 않는다.

| 대상 | 인계 기준 상태 |
| --- | --- |
| 소스 | `develop`, 제품 `7acb834` + 후속 문서 commit |
| Vercel 프로젝트 | `whos-data`, scope `dallas9115-4145s-projects` |
| 최신 GM Preview | [최종 배포](https://whos-data-phg95xmhw-dallas9115-4145s-projects.vercel.app) · `dpl_H2UJbQE4rhKv7fJPBJGSm6UyzejH` |
| 사람이 4~6명 참여 | [GM 참가 링크](https://whos-data-phg95xmhw-dallas9115-4145s-projects.vercel.app/e/dev-gm-human-20260923-c814) |
| DB 조작 없이 전체 화면 보기 | [화면 둘러보기](https://whos-data-phg95xmhw-dallas9115-4145s-projects.vercel.app/rehearsal/dev-03326f7e?view=tour) |
| Neon 개발 프로젝트 | `whos-data-rehearsal`, project ID `withered-union-13110312` |
| 개발 브랜치 / endpoint | `br-long-pine-b3e0dj0z` / `ep-morning-base-b3xwlkbw` |
| DB 상태 | development marker, migration `001`~`003_gm_progression.sql` 적용 |

이 Preview는 로그인 보호를 해제했고 마지막 검사에서 비로그인 HTTP 200을 확인했다. 소스 push가 위 고정 Preview URL을 자동 갱신한다는 뜻은 아니다. 최신 배포는 제품 파일 업로드 직후 commit을 만들었으므로 Vercel Git 메타데이터가 이전 commit을 가리킬 수 있다. 상세 이력은 [검증 기록](gm-validation-2026-09-23.md)에 있다.

`whos-data.vercel.app`의 기존 Production과 `main`은 이번 GM 작업에서 바꾸지 않았다. 예전 `kant-mingling` 배포, `kant-mingle-prototype-review`, 회사 PC의 `projects/whos-data` 폴더를 최신 GM 작업 대상으로 선택하지 않는다.

둘러보기 링크의 `?view=tour`를 유지한다. 같은 경로의 기존 감독 리허설은 21인 classic 행사이며 최신 GM 4~6인 게임이 아니다. 일반 GM `/e/<slug>`를 열려고 `REHEARSAL_EVENT_SLUG`를 사람 행사 slug로 바꿀 필요도 없다.

## 5. 집에서 개발 DB 연결하기

### A. 기존 승인된 Preview 개발 환경을 이어 쓰는 경우

집에서는 Vercel·Neon·GitHub에 다시 로그인해야 할 수 있다. 회사 PC의 `.vercel`, CLI 인증 캐시, 브라우저 쿠키를 옮기는 절차는 필요 없다. 저장소 루트의 새 `.env.local`로 환경을 준비한다. `.env.local`이 이미 있으면 내용을 출력하거나 자동 덮어쓰지 말고 기존 설정의 용도를 먼저 확인한다.

아래는 CLI `59.23.2` help에서 확인한 명령이다. `login`은 사용자가 자기 터미널·브라우저에서 마친다. `link`는 **기존** 프로젝트를 지정한다.

```sh
npx --yes vercel@59.23.2 login
npx --yes vercel@59.23.2 link --yes --team dallas9115-4145s-projects --project whos-data
npx --yes vercel@59.23.2 env pull .env.local --environment preview --git-branch develop --scope dallas9115-4145s-projects
```

`env pull` 기본값은 Development이므로 `preview`를 생략하지 않는다. 다운로드는 파일로만 받고 값을 읽거나 출력하지 않는다. CLI/계정에서 export하지 못하는 sensitive 변수 또는 누락 키는 담당자가 로컬 편집기에서 준비한다. 정상 연결을 위해 기존 공유 환경의 `AUTH_SECRET`을 임의 재생성하지 않는다.

[빈 환경변수 템플릿](../templates/environment.example) 기준으로 다음 키가 필요하다.

- `DATABASE_URL`: 개발 pooled 연결.
- `DATABASE_URL_UNPOOLED`: 같은 DB의 direct 연결.
- `AUTH_SECRET`: 서버 인증 secret.
- `DEVELOPMENT_NEON_ENDPOINT`: Neon 콘솔에서 독립적으로 확인한 개발 endpoint ID. 위 기록과 현재 대상을 대조한다. 접속 URL에서 뽑은 값을 그대로 승인 목록으로 쓰지 않는다.
- `PRODUCTION_NEON_ENDPOINT`: 운영 tooling을 사용할 때 별도로 필요하며 개발 endpoint와 달라야 한다. 이번 로컬 개발을 위해 운영 인증값을 가져오지 않는다.

스크립트는 `.env.local`을 런타임에 로드한다. Next 전용 `.env.development.local`에만 설정하면 관리 스크립트가 못 읽을 수 있다. 비밀값에 `NEXT_PUBLIC_` 접두사를 붙이지 않는다. `npm run db:check`는 연결만 확인하며 endpoint·marker·migration 검사를 대신하지 않는다.

공유 개발 DB는 이미 migration 003까지 적용했다. 새 PC라는 이유로 표지 생성·seed·reset을 다시 실행하지 않는다. DB를 쓰기 전에 [DB 대상 검사](../src/server/db/database-target.mjs)와 [marker 검사](../scripts/helpers/database.mjs)를 통과해야 한다. 읽기 전용 사전 점검은 아래처럼 기존 helper로 할 수 있다(저장소 루트, PowerShell).

```powershell
@'
import { loadLocalEnvironment, openDevelopmentClient, assertDevelopmentMarker } from './scripts/helpers/database.mjs';
let client;
try {
  loadLocalEnvironment();
  if (!process.env.AUTH_SECRET?.trim()) throw new Error('Missing required key.');
  let databaseName;
  for (const direct of [false, true]) {
    client = await openDevelopmentClient({ direct });
    await assertDevelopmentMarker(client);
    const result = await client.query('SELECT current_database() AS name');
    const currentName = result.rows[0].name;
    if (databaseName !== undefined && databaseName !== currentName) throw new Error('Database mismatch.');
    databaseName = currentName;
    await client.end();
    client = undefined;
  }
  console.log('Pooled/direct development targets, markers and required keys: OK');
} catch {
  console.error('Development check failed. Check target and required keys locally.');
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
'@ | node --input-type=module
```

한글 PC 이름 때문에 Vercel CLI의 HTTP 헤더 오류가 생기면 [hostname 보정 helper](../scripts/vercel-ascii-hostname.cjs)를 `NODE_OPTIONS`의 `--require`로 해당 프로세스에만 적용한다. 기존 값을 보존·복원하고 운영체제 이름은 바꾸지 않는다. 계정 권한 오류는 이 문제와 구분한다.

### B. 별도 빈 개발 DB에서 실험하는 경우

[에이전트 설치 절차 C](install-agent.md#c-개발-db-준비)에 따라 새 빈 DB, 별도 secret, 독립적으로 확인한 endpoint pin, development marker, migration을 준비한다. 기존 DB에서 운영 marker나 실제 데이터가 따라온 복제본을 개발 DB로 강제 전환하지 않는다. 기존 Preview 변수는 그대로 두고 새 로컬 환경에서 시험한다. 유료 요금제 변경은 이번 인계에 포함하지 않는다.

## 6. 사람용 4~6인 테스트 이어가기

준비된 행사 `dev-gm-human-20260923-c814`는 마지막 확인 때 SETUP, 6자리(운영진A+학생01~05), 완료 프로필 0개·게임 0개·등록 세션 0개·운영진 코드 미발급이었다. **이후 사람이 사용했을 수 있으므로 지금도 빈 행사라고 가정하지 않는다.** 상태를 확인하고 그대로 이어간다.

운영진 담당자가 개발 환경을 연결한 뒤 자기 터미널에서 직접 실행한다. AI 도구가 출력 코드를 수집해 전달하지 않는다. 재발급은 기존 운영진 세션을 폐기하므로 접속할 때마다 실행하지 않는다.

```sh
node scripts/issue-operator-codes.mjs --slug dev-gm-human-20260923-c814 --name 운영진A --synthetic
```

- 4명: 운영진A+학생01~03. 관제에서 학생04·05를 결석 처리한 뒤 편성.
- 5명: 운영진A+학생01~04. 학생05를 결석 처리.
- 6명: 운영진A+학생01~05. 전원 참석 확인.

GM 포함 전원 프로필 20문항 제출 → 출석 확인 → 조 편성 → 조 배정 공개 → Game 1 전체 시작. 각자 자기 기기나 독립 브라우저 세션을 쓴다. 같은 브라우저 일반 탭 여러 개는 별도 참가자가 아니다. 게임 중 GM은 ‘내 투표 화면으로’로 리모컨을 닫고 본인 투표도 한다.

새 리허설을 만들 필요가 있으면 기존 기록을 지우지 않고 새 slug를 쓴다. 아래 PowerShell은 고유 slug를 만들며 합성 명단만 seed한다. 프로필과 운영진 코드는 자동 작성하지 않는다.

```powershell
$gmRosterPath = 'roster-gm.local.json'
if (Test-Path -LiteralPath $gmRosterPath) { throw 'Roster already exists. Choose another .local.json filename.' }
Copy-Item -LiteralPath templates/roster-gm.example.json -Destination $gmRosterPath
$gmHomeSlug = 'dev-gm-home-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
node scripts/seed-event.mjs --roster $gmRosterPath --slug $gmHomeSlug --synthetic
```

기존 `roster-gm.local.json`이 있으면 덮어쓰지 말고 다른 `.local.json` 파일명을 사용한다. 새 slug는 `/e/<slug>`와 코드 발급 명령 양쪽에 동일하게 넣는다. 위 공유 DB에 seed했다면 기존 GM Preview로도 새 행사에 참여할 수 있고, 독립 DB를 썼다면 해당 DB에 연결한 앱으로 접속한다.

`npm run seed:dev`, `npm run rehearsal`, `npm run rehearsal:reset`은 classic 도구다. 현재 GM 사람이 쓰는 행사를 대신 준비하거나 초기화하는 명령으로 사용하지 않는다. 전체 진행표는 [GM 사람 리허설](gm-human-rehearsal.md)에 있다.

## 7. 검증된 것과 남은 일

이 표는 과거 실행 결과다. 이번 인계나 집 PC에서 새로 실행한 결과와 구분한다.

| 검증 | 2026-09-23 결과와 한계 |
| --- | --- |
| 기본 검사 | lint·typecheck·20문항 콘텐츠·build 통과 |
| 단위 검사 | 12파일 91개 통과 |
| 개발 DB | 전체 23파일 56개 통과(약 18분 20초), 실행 중 추가한 GM 시작 조건 회귀 1개 별도 통과 |
| GM 규모·진행 | 4명/6명 한 조, 10판·20단서 소진; 12명 3조(학생9+GM3), 조당 1명 이동·다른 판 속도·4회차 이동 |
| 원격 Preview | 합성 4인 독립 HTTP 세션, 255요청·반복 assertion 449개 통과, 5xx/네트워크 실패 0 |
| 정답 검사 | 검사 전용 DB 정답으로 제출한 오라클 방식. 자연 추리·사람의 재미 검증이 아님 |
| UI | 360×640 브라우저 GM 화면·튜토리얼 수동 이동·최종 입장/둘러보기 확인. 실물 휴대폰 검사가 아님 |

관련 코드가 바뀌면 기본 검사를 다시 실행하고, DB 동작 변경에는 `npm run test:db`를 실행한다. 이 DB runner에는 파일 필터 인자를 넘기지 않는다. 과거 통과 개수를 현재 검사 결과로 복사하지 않는다.

최신 tracked 원격 검사기는 [gm-remote 설명](../scripts/audit/gm-remote/README.md)의 `smoke.mjs`다. 지정된 개발 DB의 **새 합성 4인 행사만** 만들고 종료·세션 폐기한다. 명시적으로 원격 검증을 수행할 때 다음 명령을 사용한다. 실행 전 현재 Preview와 연결 개발 DB가 같은 대상을 쓰는지 확인한다.

```sh
node scripts/audit/gm-remote/smoke.mjs --base https://whos-data-phg95xmhw-dallas9115-4145s-projects.vercel.app --allow-remote
```

기존 사람용 행사에 자동 참가·투표·정답 제출하지 않는다. 회사 PC에만 남은 `scripts/audit/claude-six/`, `scripts/audit/codex-remote-six/`는 이전 단일 `km_session` 쿠키를 가정한 감사 자료다. 현재는 행사별 `km_session_<hash>`를 사용하므로 이를 최신 GM 검사기로 복사해 실행하지 않는다.

다음 우선순위:

1. **실제 사람 4명 또는 6명 GM 리허설.** 후보에서 제외된 사람도 이야기하는지, 질문과 버튼이 대화를 끊는지, 실물 휴대폰·행사 Wi-Fi 상태를 기록한다.
2. **GM 21명·3조·조당 학생 3명 이동 검증.** 현재 12명·1명 이동 엔진 검사와 기존 classic 21인 회귀는 이를 대신하지 않는다. 별도 합성 행사와 독립 세션으로 계획한다.
3. **콘텐츠 검토 반영.** [현재 20문항](profile-questions.md)과 `src/content/questions.v2.json`을 함께 갱신하고 원문 검사를 유지한다. 아직 받지 않은 최종 질문을 임의로 만들지 않는다.
4. **DB 전송량 줄이기.** snapshot이 전체 이력을 읽는 구조는 남아 있다. 과거 Neon Free 전송 한도 초과가 있었으므로 불필요한 장기 폴링·전체 감사 반복을 피하고 측정 후 개선한다. 이전 중단 DB로 되돌리지 않는다.
5. **Vercel 연동 상태 확인.** 마지막 앱 배포는 READY·DB healthy였으나 별도 `Neon branching` check는 실패했다. 상세 원인은 미확정이다. 앱 장애와 구분해 조사하며 연동 해제나 유료 전환으로 임의 해결하지 않는다.

## 8. 파일 지도와 가져오지 않아도 되는 자료

| 용도 | 저장소 경로 |
| --- | --- |
| 진행 화면 | `src/components/admin/GMRemote.tsx`, `src/components/admin/AdminPanel.tsx`, `src/components/player/GameBoard.tsx`, `src/components/player/GameOverlays.tsx` |
| 서버 규칙 | `src/server/services/admin-service.ts`, `src/server/services/game-service.ts`, `src/server/services/block-service.ts` |
| 정보 전달 경계 | `src/server/dto/state-dto.ts`, `src/server/auth/session.ts` |
| GM DB 변경 | `db/migrations/003_gm_progression.sql` |
| 합성 명단 | `templates/roster-gm.example.json` |
| GM·쿠키 DB 검사 | `tests/integration/t36-gm-mode.test.ts`, `tests/integration/t37-event-cookies.test.ts` |
| 원격 결과 | `scripts/audit/gm-remote/RESULT-2026-09-23.md`, [종합 검증 기록](gm-validation-2026-09-23.md) |
| 공개 디자인 맥락 | [디자인 자료](design-assets.md), 저장소의 사용 중인 브랜드 자산 |

`.env*`, `.vercel`, `*.local.json`, `*.local.md`, `node_modules`, `.next`, 회사 PC 바탕화면의 바로가기·코드 발급 `.cmd`, Figma 원본, 비공개 Slack 발췌·감사 raw 자료는 Git으로 따라오지 않는다. **앱 소스·현재 규칙·재현 절차는 이 저장소만으로 인계된다.** 회사 내부 원문을 따로 확인해야 할 때만 권한 있는 Slack/Figma에서 찾는다.

회사 PC의 `KANT Mingling/06_클로드 GM 감사 프롬프트.local.md`는 내부 맥락이 담긴 선택적 보조 자료이며 공개하지 않는다. Figma 원본은 `스파르타 디자인 자료` 폴더에 보관돼 있다. 원본을 집에 별도로 가져가더라도 공개 Git에 넣지 않는다. 회사 PC용 `05_호스트 코드 발급.cmd`에는 절대 경로가 있으므로 집에서는 위의 저장소 루트 CLI 명령을 사용한다.

## 9. 작업을 마칠 때

수정 파일·실행한 검사·남은 제한·실제 배포 여부를 기록하고 `develop` 또는 합의한 하위 브랜치에 commit/push한다. 문서 갱신만으로 재배포·DB 변경·main 병합을 수행하지 않는다. 배포가 필요한 제품 변경은 현재 프로젝트·Preview 환경·대상 commit을 확인한 뒤 실행하고 새 URL을 인계 문서에 남긴다. 기존 승인 범위는 존중하되 이 문서만으로 Production 변경 권한을 추정하지 않는다.

비공개 환경파일·운영진 코드·내부 Slack 원문을 staging하지 않도록 변경 파일을 명시해 `git add`한다. 테스트 때문에 켠 로컬 서버·브라우저 폴링은 종료하거나 사용자에게 URL과 종료 방법을 넘긴다.
