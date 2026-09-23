# KANT Mingling · Whose Data?

서로의 취향을 단서로 같은 조의 Data Owner를 찾는 행사 웹앱입니다. QR 입장, 이름 선택, A/B 프로필 20문항, 독립적인 조별 게임, 운영진 관제와 자리 이동을 지원합니다.

`develop`에서는 **GM 모드**를 추가하고 있습니다. 조 운영진이 대화 뒤 다음 단서·추리를 열고, 판 수와 자리 이동 시점을 조절합니다. `gameplayMode: "gm"`으로 만든 새 행사에 적용되며, 기존 행사는 classic 방식으로 유지됩니다. 현재 검증·배포 상태는 [GM 운영 안내](docs/gm-mode.md#9-구현검증-기록)를 확인하세요.

Next.js 16 · React 19 · TypeScript · PostgreSQL/Neon · Vercel로 만들었습니다. Node.js **24.x**와 npm을 사용합니다.

## 설치와 배포

- **처음 설치하는 사람:** [설치·배포 안내](docs/install-human.md)
- **AI 에이전트에게 맡길 때:** [에이전트 실행 지침](docs/install-agent.md), [AGENTS.md](AGENTS.md)
- **게임과 코드 구조:** [기술 개요](docs/architecture.md)
- **GM이 대화를 진행하는 새 방식:** [GM 운영 안내](docs/gm-mode.md)
- **사람이 4~6명 모여 GM 방식으로 테스트:** [GM 리허설 시작 안내](docs/gm-human-rehearsal.md)
- **인원·역할 확장 계획:** [개선 로드맵](docs/evolution-roadmap.md)
- **접속·DB 한도 문제:** [문제 해결 안내](docs/troubleshooting.md)
- **외부에서 혼자 게임 검토:** [감독 리허설 안내](docs/remote-rehearsal.md) — develop · Preview 배포와 HTTP 검증 완료
- **6명이 한 조로 직접 테스트:** [6인 리허설 안내](docs/six-person-rehearsal.md) — 호스트 1명도 게임 참여
- **프로필 콘텐츠:** [20문항과 후속 대화 질문](docs/profile-questions.md)

```sh
git clone https://github.com/bae-kanghyeok/kant-mingling.git
cd kant-mingling
npm ci
```

이후 자신의 Neon 개발 DB와 환경변수를 설정해야 합니다. `templates/environment.example`을 참고하세요. 연결 정보를 저장소·이슈·채팅에 올리지 마세요. 기존 운영자의 Vercel/Neon 계정이나 실제 참가자 명단은 포함하지 않습니다.

```sh
npm run migrate
npm run seed:dev -- --quiet
npm run dev
```

합성 행사의 `/e/<slug>` 주소는 seed 출력에서 확인합니다. 혼자 전원 참여 후 게임을 시험하려면 `npm run rehearsal`을 실행하고 `http://127.0.0.1:3100`을 엽니다. 이 도구는 합성 참가자 21명의 프로필과 게임을 준비하며 로컬에서만 동작합니다.

위 기본 seed와 기존 단독 리허설은 classic 행사입니다. GM 모드를 시험하려면 migration 적용 후 `templates/roster-gm.example.json`을 `roster-gm.local.json`으로 복사하고, 아직 사용하지 않은 합성 행사 slug로 생성하세요. 아래 예시는 학생 5명과 GM 1명의 새 행사를 만듭니다.

```sh
node scripts/seed-event.mjs --roster roster-gm.local.json --slug dev-gm-first-run --synthetic
```

운영진 코드는 담당자가 자기 터미널에서 `node scripts/issue-operator-codes.mjs --slug dev-gm-first-run --synthetic`을 실행해 수령합니다. 코드를 저장소나 채팅에 붙여 넣지 마세요. 각 참가자는 `/e/dev-gm-first-run`에 입장해 직접 프로필을 작성합니다. 4인·21인 구성과 시작·이동 절차는 [GM 운영 안내](docs/gm-mode.md)를 따르세요. 같은 slug를 초기화해 재사용하지 말고 새 이름을 선택합니다.

## 브랜치

| 브랜치 | 용도 |
| --- | --- |
| `main` | 기존에 검증한 게임 동작을 보존한 공개 기준 버전. 새 계정 설치를 위한 설정 일반화와 안내 포함 |
| `develop` | 회사 디자인에 맞춘 UI 개편과 추후 확장 작업. 검토 후 main에 반영 |

Vercel Git 자동 배포는 별도로 연결해야 합니다. `main`을 Production 기준으로 지정하더라도 실제 운영 배포와 DB 변경은 운영자가 검토 후 실행합니다. UI 브랜치를 만들었다고 운영 중인 사이트가 자동으로 바뀌지 않습니다.

## 현재 범위

- 공통: 프로필 20문항, GM도 참여·Owner 후보, 점수·순위 없음
- classic: 기본 학생 18명 + 운영진 3명, 3블록 × 3게임, 참가자 Turn Lead가 다음 단서·추리 진행
- GM: 다음 단서·추리 열기·Ensemble 진행은 조 GM, 다음 판 Noise 최대 0~5·Ground Truth 사용 여부 설정, 전 조 이동 준비 후 총괄 확정. 판·구간을 3회나 9회로 제한하지 않음
- 인원·조 수 설정과 불균등 배정, 명단 관리, 호스트 이전 지원
- 현재 제약은 **조마다 운영진 1명, 전체 호스트 1명**. 한 조는 이동 인원 0명으로 진행합니다. 6인 실참여 행사와 별도로, 혼자 역할을 바꾸는 감독 리허설은 21명 고정입니다.
- Data Split, Turn Lead, Noise, Ensemble, Ground Truth, 정답 공개와 후속 대화
- 행사별 세션 복구, 명령 중복·동시성 제어, 관리자에게도 공개 전 정답 비노출

## 검증

```sh
npm run lint
npm run typecheck
npm test
npm run check:content
npm run build
# 개발 DB 설정과 migration 완료 후
npm run test:db
```

정식 행사 전 실제 스마트폰과 행사 Wi-Fi에서 리허설해야 합니다. 자동 검사와 로컬 시뮬레이션은 현장 네트워크·브라우저 조합 전체를 검증하지 않습니다.

develop에서 디자인만 검토하려면 `npm run dev` 후 `/design-preview`를 엽니다. 기존 등록·프로필·카드·투표·정답·관제 33개 화면에 GM 튜토리얼·대화·추리 열림·리모컨·다음 판 설정·이동 준비 6개 보기를 더해 **총 39개**입니다. 합성 화면만 전환하며 실제 게임 진행과 구분합니다. `/design-preview`는 Production 빌드에서 404를 반환합니다. 배포된 화면 둘러보기는 별도 안내된 주소를 사용하세요.

## 코드와 디자인 자료

회사 Figma 원본 전체와 과거 내부 작업 기록은 공개 저장소에 포함하지 않습니다. 브랜드 자산 안내는 [디자인 자료](docs/design-assets.md)에 있습니다. 공개 열람과 별개로 코드·상표·캐릭터에 포괄적인 재배포 라이선스를 부여한 것은 아니며, 명시적인 오픈소스 라이선스는 아직 지정하지 않았습니다.
