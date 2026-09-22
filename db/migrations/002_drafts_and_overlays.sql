-- Mutable next-block plans are separate from the current event/game snapshot.
ALTER TABLE events ADD COLUMN pending_config_json jsonb;
ALTER TABLE events ADD COLUMN pending_roster_json jsonb;
ALTER TABLE events ADD COLUMN draft_assignments jsonb;
ALTER TABLE participants ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE teams ADD COLUMN settings_json jsonb NOT NULL DEFAULT '{}';
CREATE TABLE game_overlay_seen (
  game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id uuid NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('noise','ensemble','ground_truth')),
  seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (game_id, participant_id, kind)
);
