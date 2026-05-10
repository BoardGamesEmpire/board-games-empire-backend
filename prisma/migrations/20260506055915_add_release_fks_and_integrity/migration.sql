-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger function: ensures GameRelease referenced by a downstream model
-- belongs to the same PlatformGame the model is also referencing.
--
-- Used by: game_collections, game_lists, event_games, event_game_nominations,
--          game_play_sessions
-- Column convention: NEW.release_id + NEW.platform_game_id
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION assert_release_matches_platform_game()
RETURNS TRIGGER AS $$
BEGIN
  -- Only validate when release_id is being set. Null release_id is the
  -- valid "no edition specificity" state; downstream model resolves
  -- against the parent PlatformGame.
  IF NEW.release_id IS NOT NULL THEN
    -- A release_id without a platform_game_id is structurally invalid:
    -- a release cannot exist independent of its parent platform game.
    IF NEW.platform_game_id IS NULL THEN
      RAISE EXCEPTION
        'Integrity violation in %: release_id % set without platform_game_id',
        TG_TABLE_NAME, NEW.release_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    -- Verify the release actually belongs to the referenced platform game.
    IF NOT EXISTS (
      SELECT 1
      FROM game_releases
      WHERE id = NEW.release_id
        AND platform_game_id = NEW.platform_game_id
    ) THEN
      RAISE EXCEPTION
        'Integrity violation in %: release_id % does not belong to platform_game_id %',
        TG_TABLE_NAME, NEW.release_id, NEW.platform_game_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger function: enforces RuleVariant's three-FK hierarchy integrity.
--
-- RuleVariant uses the same column names (release_id)
-- and additionally verifies platform_game.game_id matches
-- rule_variant.game_id — preventing a "Catan rule" from pinning to a
-- "Gloomhaven" platform game.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION assert_rule_variant_hierarchy()
RETURNS TRIGGER AS $$
BEGIN
  -- platform_game, when set, must belong to the same game as the rule variant.
  IF NEW.platform_game_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM platform_games
      WHERE id = NEW.platform_game_id
        AND game_id = NEW.game_id
    ) THEN
      RAISE EXCEPTION
        'Integrity violation in rule_variants: platform_game_id % does not belong to game_id %',
        NEW.platform_game_id, NEW.game_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  -- game_release, when set, must belong to the referenced platform_game.
  -- The CHECK constraint guarantees platform_game_id is non-null whenever
  -- release_id is set, so we can rely on it here.
  IF NEW.release_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM game_releases
      WHERE id = NEW.release_id
        AND platform_game_id = NEW.platform_game_id
    ) THEN
      RAISE EXCEPTION
        'Integrity violation in rule_variants: release_id % does not belong to platform_game_id %',
        NEW.release_id, NEW.platform_game_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- CHECK constraint: a release reference requires a platform_game reference.
-- The trigger handles cross-table integrity; this catches the structural
-- nonsense at write time without a function call.
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE rule_variants
  ADD CONSTRAINT rule_variants_release_implies_platform
  CHECK (release_id IS NULL OR platform_game_id IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────────
-- Triggers — one per table consuming each function.
-- Fires only on INSERT or when one of the relevant columns is updated.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TRIGGER game_collections_release_match
  BEFORE INSERT OR UPDATE OF release_id, platform_game_id ON game_collections
  FOR EACH ROW EXECUTE FUNCTION assert_release_matches_platform_game();

CREATE TRIGGER game_lists_release_match
  BEFORE INSERT OR UPDATE OF release_id, platform_game_id ON game_lists
  FOR EACH ROW EXECUTE FUNCTION assert_release_matches_platform_game();

CREATE TRIGGER event_games_release_match
  BEFORE INSERT OR UPDATE OF release_id, platform_game_id ON event_games
  FOR EACH ROW EXECUTE FUNCTION assert_release_matches_platform_game();

CREATE TRIGGER event_game_nominations_release_match
  BEFORE INSERT OR UPDATE OF release_id, platform_game_id ON event_game_nominations
  FOR EACH ROW EXECUTE FUNCTION assert_release_matches_platform_game();

CREATE TRIGGER game_play_sessions_release_match
  BEFORE INSERT OR UPDATE OF release_id, platform_game_id ON game_play_sessions
  FOR EACH ROW EXECUTE FUNCTION assert_release_matches_platform_game();

CREATE TRIGGER rule_variants_hierarchy
  BEFORE INSERT OR UPDATE OF game_id, platform_game_id, release_id ON rule_variants
  FOR EACH ROW EXECUTE FUNCTION assert_rule_variant_hierarchy();
