# KANT Mingling · Whose Data?

서로의 취향을 단서로 같은 조의 Data Owner를 찾는 행사 웹앱입니다. QR 입장, 이름 선택, A/B 프로필 20문항, 독립적인 조별 게임, 운영진 관제와 자리 이동을 지원합니다.

Next.js 16 · React 19 · TypeScript · PostgreSQL/Neon · Vercel로 만들었습니다. Node.js **24.x**와 npm을 사용합니다.

## 설치와 배포

- **처음 설치하는 사람:** [설치·배포 안내](docs/install-human.md)
- **AI 에이전트에게 맡길 때:** [에이전트 실행 지침](docs/install-agent.md), [AGENTS.md](AGENTS.md)
- **게임과 코드 구조:** [기술 개요](docs/architecture.md)
- **인원·역할 확장 계획:** [개선 로드맵](docs/evolution-roadmap.md)
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

## 브랜치

| 브랜치 | 용도 |
| --- | --- |
| `main` | 기존에 검증한 게임 동작을 보존한 공개 기준 버전. 새 계정 설치를 위한 설정 일반화와 안내 포함 |
| `develop` | 회사 디자인에 맞춘 UI 개편과 추후 확장 작업. 검토 후 main에 반영 |

Vercel Git 자동 배포는 별도로 연결해야 합니다. `main`을 Production 기준으로 지정하더라도 실제 운영 배포와 DB 변경은 운영자가 검토 후 실행합니다. UI 브랜치를 만들었다고 운영 중인 사이트가 자동으로 바뀌지 않습니다.

## 현재 범위

- 기본 18명 학생 + 운영진 3명, 3블록 × 3게임, 프로필 20문항
- 인원·조 수 설정과 불균등 배정, 명단 관리, 호스트 이전 지원
- 현재 제약은 **조마다 운영진 1명, 전체 호스트 1명**. 리허설은 21명 고정이며 임의 규모의 행사 검증을 의미하지 않습니다.
- Data Split, Turn Lead, Noise, Ensemble, Ground Truth, 정답 공개와 후속 대화
- 세션 복구, 명령 중복·동시성 제어, 관리자에게도 공개 전 정답 비노출

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

## 코드와 디자인 자료

회사 Figma 원본 전체와 과거 내부 작업 기록은 공개 저장소에 포함하지 않습니다. 브랜드 자산 안내는 [디자인 자료](docs/design-assets.md)에 있습니다. 공개 열람과 별개로 코드·상표·캐릭터에 포괄적인 재배포 라이선스를 부여한 것은 아니며, 명시적인 오픈소스 라이선스는 아직 지정하지 않았습니다.
