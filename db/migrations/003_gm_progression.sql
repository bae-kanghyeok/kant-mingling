-- Additive GM progression. Existing events remain classic unless explicitly opted in.
ALTER TABLE events ADD COLUMN rotation_requested boolean NOT NULL DEFAULT false;
ALTER TABLE team_blocks ADD COLUMN rotation_ready boolean NOT NULL DEFAULT false;
ALTER TABLE games ADD COLUMN gm_guess_open boolean NOT NULL DEFAULT false;

ALTER TABLE events DROP CONSTRAINT events_current_block_check;
ALTER TABLE events ADD CONSTRAINT events_current_block_check CHECK (current_block BETWEEN 0 AND 32767);
ALTER TABLE block_assignments DROP CONSTRAINT block_assignments_block_no_check;
ALTER TABLE block_assignments ADD CONSTRAINT block_assignments_block_no_check CHECK (block_no BETWEEN 1 AND 32767);
ALTER TABLE team_blocks DROP CONSTRAINT team_blocks_block_no_check;
ALTER TABLE team_blocks ADD CONSTRAINT team_blocks_block_no_check CHECK (block_no BETWEEN 1 AND 32767);
ALTER TABLE games DROP CONSTRAINT games_block_no_check;
ALTER TABLE games ADD CONSTRAINT games_block_no_check CHECK (block_no BETWEEN 1 AND 32767);
ALTER TABLE games DROP CONSTRAINT games_game_no_check;
ALTER TABLE games ADD CONSTRAINT games_game_no_check CHECK (game_no BETWEEN 1 AND 32767);
-- Fairness counts span multiple independent teams and may exceed one team's game number.
ALTER TABLE participants ALTER COLUMN owner_count TYPE integer;
ALTER TABLE pair_history ALTER COLUMN count TYPE integer;
