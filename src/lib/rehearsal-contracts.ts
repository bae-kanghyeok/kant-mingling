export interface RehearsalState {
  ok: true;
  enabled: boolean;
  canEnable: boolean;
  selectedParticipantId: string | null;
  hostParticipantId: string;
  expiresAt: string | null;
  roster: {
    participantId: string;
    displayName: string;
    role: "student" | "operator";
  }[];
  assistedActions?: number;
}
