import "server-only";

const messages: Record<string, string> = {
  INVALID_REQUEST: "입력 내용을 다시 확인해주세요.",
  BAD_ORIGIN: "접속한 페이지에서 다시 시도해주세요.",
  UNSUPPORTED_MEDIA: "요청 형식이 올바르지 않아요.",
  BODY_TOO_LARGE: "입력 내용이 너무 길어요.",
  UNAUTHENTICATED: "다시 입장해주세요.", FORBIDDEN: "이 동작을 할 수 없어요.",
  NOT_FOUND: "행사를 찾을 수 없어요.", ENDED: "KANT Mingle 완료",
  NAME_LOCKED: "이미 입장한 이름이에요. 내 이름이 맞다면 운영진에게 잠금 해제를 요청해주세요.",
  BAD_CODE: "코드가 맞지 않아요. 다시 확인해주세요.", RATE_LIMITED: "잠시 후 다시 시도해주세요.",
  OPERATOR_CODE_REQUIRED: "운영진 코드를 입력해주세요", ALREADY_CLAIMED: "현재 등록을 취소한 뒤 이름을 다시 선택해주세요.",
  PROFILE_COMPLETE: "등록을 마친 이름은 운영진에게 잠금 해제를 요청해주세요.",
  PROFILE_LOCKED: "Game이 시작되어 답변을 수정할 수 없어요.",
  INCOMPLETE: "모든 질문에 답하면 다음 단계로 갈 수 있어요.",
  STALE_VERSION: "다른 운영진이 먼저 진행했어요. 현재 화면으로 맞췄어요.",
  STALE_REVISION: "최신 선택으로 화면을 맞췄어요.",
  NOT_TURN_LEAD: "이번 Turn Lead가 다음 행동을 선택해요.",
  GUESS_LOCKED: "새로운 Data를 확인한 뒤 다시 추리해보세요.",
  GM_GUESS_CLOSED: "GM이 추리를 열어주면 도전할 수 있어요.",
  GM_NOT_READY: "조 GM의 프로필과 출석을 확인해주세요.",
  ROTATION_PENDING: "자리 이동을 준비하고 있어요. 현재 대화를 마친 뒤 준비 완료를 눌러주세요.",
  NOT_ENOUGH_DATA: "단서를 조금 더 확인한 뒤 추리할 수 있어요.",
  WRONG_PHASE: "현재 단계에서는 할 수 없는 동작이에요.",
  PAUSED: "운영진이 잠시 멈췄어요. 곧 이어서 진행합니다.",
  REQUEST_ID_REUSED: "요청을 새로 확인한 뒤 다시 시도해주세요.",
  INTRO_REQUIRED: "새로운 규칙 안내를 먼저 확인해주세요.",
  INVALID_GUESS: "후보와 Data 번호를 다시 확인해주세요.",
  INSUFFICIENT_MEMBERS: "각 조에 프로필을 완료한 사람이 최소 2명 필요해요.",
  HOST_REPLACEMENT_REQUIRED: "먼저 다른 운영진에게 호스트를 넘겨주세요.",
  DUPLICATE_NAME: "이미 명단에 있는 이름이에요.",
  OPERATORS_INCOMPLETE: "프로필을 마치지 않은 운영진이 있어요. 준비 상태를 확인해주세요.",
  CONFIRM_REQUIRED: "종료 안내를 확인해주세요.",
  ALREADY_DELIVERED: "이미 이 Data를 받은 사람이에요.",
  STUDENT_COUNT_MISMATCH: "학생 수와 현재 명단을 맞춰주세요.",
  OPERATOR_COUNT_MISMATCH: "조마다 운영진이 한 명씩 필요해요. 명단과 조 수를 맞춰주세요.",
  INVALID_OPERATOR_ASSIGNMENT: "운영진 이름과 배정할 조를 확인해주세요.",
  EXHAUSTED: "모든 DATA가 공개되었습니다.",
  DB_UNAVAILABLE: "연결을 다시 확인하고 있어요. 잠시 후 다시 시도해주세요.",
};

export class CommandRejected extends Error {
  constructor(public status: number, public code: string, public preserveWrites = false) {
    super(messages[code] ?? messages.INVALID_REQUEST);
    this.name = "CommandRejected";
  }
}
export function reject(status: number, code: string, preserveWrites = false): never {
  throw new CommandRejected(status, code, preserveWrites);
}
export function json(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("Vary", "Cookie");
  return Response.json(data, { status, headers: responseHeaders });
}
export function errorResponse(error: unknown) {
  const failure = error instanceof CommandRejected ? error : new CommandRejected(503, "DB_UNAVAILABLE");
  return json({ ok: false, error: { code: failure.code, message: failure.message } }, failure.status);
}
