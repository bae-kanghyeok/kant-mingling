# 설치·배포 안내 — 운영 담당자용

KANT Mingling은 Next.js 앱과 Neon PostgreSQL로 실행합니다. 참가자는 행사 링크에서 이름을 선택하고 프로필을 작성하며, 운영진은 별도 코드로 입장합니다. 전체 행사를 통제하는 호스트는 운영진 중 한 명입니다.

이 문서는 다른 사람이 **자신의 GitHub·Vercel·Neon 계정**에 설치하는 절차입니다. 기존 행사 주소, DB 연결, 참가자 명단은 필요하지 않습니다. AI 에이전트에게 맡길 때는 [에이전트용 안내](install-agent.md)를 함께 전달하세요.

## 1. 준비와 브랜치 선택

준비물은 Git, Node.js **24.x**와 npm, 본인 계정의 GitHub 저장소, Vercel 프로젝트, Neon 데이터베이스입니다. `package-lock.json`에 맞춰 설치하므로 `npm install` 대신 `npm ci`를 사용합니다.

공개 저장소를 본인 계정으로 Fork한 뒤 GitHub의 Code 메뉴에서 **본인 Fork의 clone 주소**를 복사합니다. 아래 `<...>` 부분은 실제 값으로 바꿉니다.

```text
git clone <본인-Fork의-clone-주소> kant-mingling
cd kant-mingling
git switch main
node --version
npm ci
```

| 브랜치 | 용도 | 배포 대상 |
| --- | --- | --- |
| `main` | 현재 동작이 검증된 행사 버전 | Production |
| `develop` | 디자인 개편·운영 규모 확장 등 개선 통합 | Preview |
| `feature/...` | 개별 개선 작업, `develop`에서 분기 | Preview |

브랜치를 나누는 것만으로 DB가 분리되지는 않습니다. Preview에 운영 DB 연결을 넣지 마세요. Vercel Git 연동에서는 Production branch로 지정한 브랜치의 변경이 운영 배포로 이어지므로, `main` 반영 전에 배포 시점을 정합니다. [Vercel Git 배포 문서](https://vercel.com/docs/git)

## 2. 개발·운영 DB를 분리하기

처음 설치할 때는 **서로 다른 빈 Neon DB 두 개**를 준비하는 것이 가장 명확합니다. 별도 프로젝트 두 개를 사용하거나, 동일 프로젝트에서 아무 테이블도 만들기 전에 development와 production 브랜치를 분리하세요. 앱과 DB 리전은 가깝게 맞춥니다. 저장소의 `vercel.json` 기본 함수 리전은 `sin1`입니다.

Neon 브랜치는 원본의 스키마와 데이터를 복제할 수 있습니다. 운영 표지나 실제 참가자가 들어간 DB를 그대로 복제해서 개발용으로 쓰지 마세요. 이 앱은 DB에 `app_environment` 표지를 저장하고, production 표지가 있는 DB에 development 표지를 덮어쓰지 않습니다. [Neon 브랜치 안내](https://neon.com/docs/get-started-with-neon/workflow-primer)

각 DB의 Neon 연결 화면에서 아래 두 연결을 받아 로컬 편집기나 비밀값 저장소에 보관합니다.

- **Pooled connection** → `DATABASE_URL`: 앱과 일반 행사 관리 명령용.
- **Direct connection** → `DATABASE_URL_UNPOOLED`: 환경 표지와 migration용. 호스트에 `-pooler`가 없어야 합니다.

Neon의 pooled 연결은 `-pooler` 호스트를 사용합니다. 이 프로젝트의 migration은 연결 단위 잠금을 사용하므로 반드시 direct 연결로 실행합니다. [Neon 연결 방식 안내](https://github.com/neondatabase/agent-skills/blob/main/plugins/neon-postgres/skills/neon-postgres/SKILL.md#when-to-use-pooled-vs-direct-connections)

연결 URL과 별개로 Neon 대시보드에서 **각 compute의 endpoint ID**도 확인합니다. `ep-`로 시작하는 ID이며 URL 전체도, `-pooler`가 붙은 값도 아닙니다. 이 값을 별도로 고정해 잘못된 DB에 쓰는 실수를 막습니다.

## 3. 환경변수 입력

프로젝트 루트에 개발용 `.env.local`을 **본인 편집기에서** 만듭니다. 키 이름은 [환경변수 예시](../templates/environment.example)를 참고합니다. 파일 내용은 Git, 채팅, 스크린샷에 넣지 않습니다. AI에게 파일을 열어달라고 요청할 필요도 없습니다.

| 이름 | 개발용 값 | 용도 |
| --- | --- | --- |
| `DATABASE_URL` | 개발 DB의 pooled 연결 URL | 앱의 서버 쿼리 |
| `DATABASE_URL_UNPOOLED` | 같은 개발 DB의 direct 연결 URL | migration·환경 표지 |
| `AUTH_SECRET` | 이 환경만 사용하는 충분히 긴 무작위 비밀값 | 세션 토큰 해시 |
| `DEVELOPMENT_NEON_ENDPOINT` | 별도로 확인한 개발 endpoint ID | 개발 명령의 대상 검사 |
| `PRODUCTION_NEON_ENDPOINT` | 운영 DB가 준비됐다면 별도로 확인한 운영 endpoint ID | 두 환경 혼동 방지 |

`AUTH_SECRET`은 비밀번호 관리자의 무작위 생성 기능 등으로 **32바이트 이상에 해당하는 난수**를 만들고 개발·운영에서 서로 다르게 사용하세요. 값을 바꾸면 기존 참가자 세션을 사용할 수 없게 되므로 행사 중에는 유지합니다. 위 변수에 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

운영 준비 때는 별도 `.env.production.local`을 만듭니다. 같은 변수 이름을 사용하되 DB URL 두 개와 `AUTH_SECRET`은 **운영 값**, endpoint 두 개는 각각 개발·운영 DB의 ID입니다. 운영 명령에도 `DEVELOPMENT_NEON_ENDPOINT`가 필요합니다. 두 endpoint ID는 달라야 합니다.

명령 스크립트는 개발 작업에 `.env.local`, 명시적 운영 작업에 `.env.production.local`을 로드합니다. 이미 터미널에 설정된 환경변수는 파일로 덮어쓰지 않으므로, 운영용은 개발 변수를 상속하지 않는 별도 터미널에서 실행합니다. `.env.production.local`이 있는 폴더에서는 일반 로컬 production 빌드·실행도 그 파일을 사용할 수 있으므로, 운영 작업은 **개발·리허설과 분리한 checkout**에서 진행하는 것을 권장합니다.

## 4. 개발 DB 초기화와 코드 검증

개발 설정을 입력한 checkout의 루트에서 순서대로 실행합니다. 실패한 명령이 있으면 다음 단계로 넘어가지 않습니다.

```text
node scripts/mark-environment.mjs development
npm run migrate
npm run db:check
npm run lint
npm run typecheck
npm test
npm run check:content
npm run test:db
npm run build
```

첫 명령은 development 표지를 만들고, migration은 `db/migrations`의 SQL을 순서대로 적용합니다. migration도 빈 DB의 표지를 만들 수 있어 첫 명령은 필수는 아니지만 대상 확인 단계를 명확히 하기 위해 분리했습니다. 이미 적용한 migration은 체크섬을 확인하고 건너뜁니다. 적용한 SQL 파일을 나중에 수정하지 마세요.

`db:check`는 연결 성공과 필수 키 존재만 확인합니다. 스키마·권한·게임 동작까지 정상이라는 뜻은 아닙니다. `test:db`는 development 표지를 확인한 뒤 합성 행사를 만들고 정리하는 **DB 쓰기 테스트**입니다. 운영 DB에서는 실행하지 않습니다.

## 5. 합성 참가자로 실행하기

### 한 대의 PC에서 21명 게임 체험

```text
npm run rehearsal
```

준비 완료 후 [http://127.0.0.1:3100](http://127.0.0.1:3100)을 엽니다. 학생 18명과 운영진 3명, 프로필 20문항, 조 편성, 첫 게임이 준비됩니다. 컨트롤러에서 참가자를 바꾸거나 호스트 관제를 열 수 있습니다. 가상 참가자는 안내 확인·투표를 보조하지만 게임 진행과 자리 이동은 직접 합니다.

이 컨트롤러는 **로컬 전용**이고 고정 21명입니다. 포트 `3002`, `3100~3121`이 비어 있어야 하며 `localhost`로 주소를 바꾸지 않습니다. 다른 기기에 공유하거나 서버에 공개하지 마세요. 종료는 `Ctrl+C`이며 합성 기록은 남고, 다시 실행하면 새 행사를 만듭니다. 자세한 조작은 [리허설 안내](rehearsal.md)에 있습니다.

### 등록부터 확인하거나 여러 기기에서 확인

```text
node scripts/seed-dev-event.mjs
npm run dev
```

첫 명령이 출력하는 `/e/dev-...`를 개발 앱 주소 뒤에 붙입니다. 이 행사는 프로필이 비어 있어 학생 이름 선택부터 확인할 수 있습니다. 운영진 코드는 본인 터미널에 한 번만 표시되므로 필요한 운영 담당자에게 별도로 전달합니다. 출력 로그를 Git이나 채팅에 올리지 않습니다.

배포한 Preview에서는 `http://localhost:3000` 대신 Preview의 HTTPS 주소에 같은 경로를 붙입니다. 이때 Preview가 **같은 개발 DB**를 사용해야 행사가 보입니다. 한 브라우저에서 이름을 여러 개 선택하는 방식은 여러 사람 테스트를 대신하지 못하므로, 실제 기기 또는 분리된 브라우저 세션을 사용합니다.

합성 행사의 빈 프로필을 채워 관제부터 확인하려면 아래처럼 실제 생성된 slug를 넣습니다. 기존 답변은 유지되며, 시작 전 `SETUP` 행사만 허용됩니다.

```text
node scripts/prepare-dev-rehearsal.mjs --slug dev-실제slug --synthetic
```

## 6. Vercel 설치와 Preview 확인

1. Vercel에서 본인의 Fork를 **새 프로젝트**로 Import합니다. 기존 다른 프로젝트를 선택하지 않습니다.
2. Framework는 Next.js, Root Directory는 저장소 루트, Node.js는 24.x로 맞춥니다. Install은 `npm ci`, Build는 `npm run build`를 사용하고 Output Directory는 Next.js 기본값으로 둡니다. **Build command에 migration이나 seed를 넣지 않습니다.**
3. Production branch는 `main`으로 지정합니다. `develop`은 Preview로 사용합니다.
4. Project Settings의 환경변수에서 **Development·Preview에는 개발 DB URL과 개발 AUTH_SECRET**, **Production에는 운영 DB URL과 운영 AUTH_SECRET**을 각각 입력합니다. `DATABASE_URL`과 `AUTH_SECRET`은 앱 실행에 필수입니다. 이 프로젝트의 관리 스크립트도 Vercel에서 받은 환경을 사용할 예정이면 direct URL과 endpoint ID들도 같은 구분으로 등록합니다.
5. `develop`을 배포하여 Preview를 먼저 확인합니다. Import 시 생성되는 첫 배포도 `main`의 Production 배포일 수 있으므로 운영 설정·대상을 갖춘 뒤 진행하거나 초기 배포의 공개 범위를 관리하세요.
6. Preview의 `/api/health`에서 `app: ok`, `database: ok`를 확인하고, 합성 행사의 `/e/<slug>`에서 등록·프로필·게임·관제를 확인합니다. Preview의 접근 보호가 켜져 있으면 테스트 참가자에게 허용된 접근 방법을 안내합니다.

환경변수 변경은 기존 배포에 자동 반영되지 않으므로 새 배포가 필요합니다. 환경별 값을 나눠 등록하는 방법은 [Vercel 환경변수 문서](https://vercel.com/docs/environment-variables)를 참고하세요.

Neon–Vercel 계정 통합은 필수가 아닙니다. 두 연결 URL과 환경변수를 직접 등록해도 동작합니다. 통합을 사용한다면 설치 중인 프로젝트 하나와 의도한 DB만 연결되어 있는지 확인합니다.

## 7. 실제 행사 준비와 운영 배포

운영 DB 작업은 행사 담당자가 대상·명단·배포 시점을 확인한 뒤 실행합니다. AI에게 맡기는 경우에도 구체적인 운영 대상에 대한 기존 승인 범위 안에서만 실행하도록 합니다. `--approved`라는 문자열 자체가 승인을 대신하지 않습니다.

별도의 운영 checkout에 `.env.production.local`을 준비하고, 다음 명령으로 빈 운영 DB를 초기화합니다.

```text
node scripts/mark-environment.mjs production --production --approved
node scripts/migrate.mjs --production --approved
```

명단은 [명단 예시](../templates/roster.example.json)를 참고해 Git에서 제외되는 `roster.local.json`에 작성합니다. 아래는 **형식 설명용 합성 명단**입니다.

```json
{
  "title": "우리 팀 Mingling",
  "students": ["학생01", "학생02", "학생03", "학생04", "학생05", "학생06"],
  "operators": [
    { "name": "운영진A", "team": "A" },
    { "name": "운영진B", "team": "B" }
  ],
  "host": "운영진A",
  "moveCountPerTeam": 1,
  "blockTargetMinutes": [12, 12, 15]
}
```

현재 구조에서 운영진은 조마다 한 명이고 운영진 수가 조 수가 됩니다. 전체 호스트는 이 중 한 명으로 `host`에 정확히 지정합니다. 이름은 전체 명단에서 유일해야 하며, 조 키는 A부터 연속이어야 합니다. 운영진은 2~26명, 학생은 최소 운영진 수 이상, 이동 인원은 가장 작은 조의 학생 정원 이하여야 합니다. 이는 입력 검증 범위이며 **26조 운영을 성능 검증했다는 뜻은 아닙니다.** 최초 게임 시작에는 각 조의 프로필 완료자 최소 2명도 필요합니다.

표준 18명·3조 행사는 학생 18명·운영진 3명·이동 3명으로 작성합니다. 명단 파일이 다른 사람에게 공유되거나 커밋되지 않는지 확인한 뒤 새 slug로 생성합니다.

```text
node scripts/seed-event.mjs --roster roster.local.json --slug our-mingling --production --approved
node scripts/issue-operator-codes.mjs --slug our-mingling --production --approved
```

seed는 명단·호스트를 만들고 기존 slug를 덮어쓰지 않습니다. 운영진 코드는 두 번째 명령에서 한 번 표시되며 DB에는 해시만 저장됩니다. **운영 담당자가 자기 터미널에서 직접 실행해 수령**하는 방법을 권장합니다. 분실하면 특정 운영진만 재발급할 수 있고, 해당 운영진의 기존 세션은 폐기됩니다.

```text
node scripts/issue-operator-codes.mjs --slug our-mingling --name "운영진 표시 이름" --production --approved
node scripts/set-host.mjs --slug our-mingling --name "새 호스트 표시 이름" --production --approved
```

검증한 `main`을 Vercel Production으로 배포하고 `/api/health`, `/e/our-mingling`을 확인합니다. 참가자용 QR은 **행사 경로까지 포함한 Production HTTPS 주소**로 만듭니다. 사이트 루트 `/`는 행사 선택 화면이 아닙니다.

실제 운영진이 코드로 접속하고 프로필을 작성한 뒤, 호스트의 관리자 패널에서 조 편성 초안 → 배정 공개 → Game 시작 흐름을 확인합니다. 학생은 이름 선택 → 등록 → 프로필 제출을 진행합니다. 실제 명단의 답변을 테스트 도구로 자동 채우지 않습니다.

## 8. 행사 전 확인과 복구

| 확인할 것 | 통과 기준 |
| --- | --- |
| 연결 | 운영 주소의 health가 정상이고 행사 이름·명단이 맞음 |
| 권한 | 학생에게 관제가 없고, 일반 운영진과 전체 호스트의 기능이 구분됨 |
| 정보 공개 | Data는 수신자에게만 보이고 공개 전 정답은 운영진에게도 보이지 않음 |
| 재접속 | 같은 브라우저에서 새로고침해도 본인 진행이 유지됨 |
| 관제 | 연결 인원·진행 단계, 일시정지·재개, 다음 게임·블록 공개 동작 확인 |
| 실제 기기 | 사용하는 iOS·Android·인앱 브라우저에서 등록, 모달, 투표, 좌석 이동 확인 |

자동 테스트와 한 PC 리허설은 실제 참가자 전원의 기기·네트워크 검증을 대신하지 않습니다. 기기를 바꿔 입장이 잠겼으면 운영진이 해당 참가자의 잠금을 해제한 뒤 본인 이름으로 다시 입장시킵니다. 코드 재발급이나 `AUTH_SECRET` 변경은 기존 세션에 영향을 줍니다.

앱 문제는 마지막으로 검증한 commit·Vercel 배포로 되돌릴 수 있지만, **코드 롤백은 DB를 되돌리지 않습니다.** 이 저장소에는 down migration이나 운영 행사 초기화 명령이 없습니다. 운영 migration 전에 Neon의 복구 가능 시점·보관 기간을 해당 계정에서 확인하고, 복구가 필요하면 앱과 DB의 호환성을 함께 검토합니다. 진행 중인 행사 DB에 테스트·reset 명령을 실행하지 않습니다.

개발 행사를 지우려면 정확한 합성 slug에만 아래 명령을 사용합니다. 해당 행사의 참가자·답변·게임 이력이 삭제됩니다.

```text
node scripts/reset-dev-event.mjs --slug dev-실제slug
```

## 9. 자주 막히는 지점

| 증상 | 확인할 내용 |
| --- | --- |
| migration·seed가 구성 오류로 중단 | endpoint ID 두 개, direct/pooled 구분, 현재 터미널의 환경, marker 대상 확인. 비밀값을 출력해 디버깅하지 않음 |
| development 표지 오류 | 운영에서 복제한 DB인지 확인. marker를 지우거나 강제로 바꾸지 말고 합성 데이터 전용 빈 DB로 다시 준비 |
| health는 정상인데 행사 없음 | 올바른 DB인지, seed가 성공했는지, 정확한 `/e/<slug>`인지 확인 |
| 운영진 로그인 실패 | 이름에 맞는 최신 코드인지 확인. 재발급 시 이전 코드는 사용할 수 없음 |
| Preview에서는 되고 Production에서는 실패 | 환경변수의 환경 범위와 배포 시점, 운영 DB migration·seed 여부 확인 |
| 리허설 시작 실패 | 포트 `3002`, `3100~3121`, 개발 DB, 최신 빌드 확인. 다른 프로세스를 무작정 종료하지 않음 |
| Vercel CLI가 Windows 호스트명 때문에 실패 | 대시보드 Git 배포를 사용하거나 저장소의 `scripts/vercel-ascii-hostname.cjs` 사용법을 검토. 서버·DB 오류와 구분 |

고도화는 `develop`에서 검증하고, 운영 버전에 반영할 변경·DB 영향·검증 기록을 정리한 PR로 `main`에 병합합니다. 인원 설정 범위와 향후 다중 호스트·조 운영진 분리 방향은 현재 지원 기능과 구분해서 판단하세요.
