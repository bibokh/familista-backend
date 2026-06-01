-- Migration: rename every legacy non-UUID Player.id (e.g. "player-15-fhsr"
-- from the FC Familista seed) to a real UUID, propagating to every FK and
-- every orphan "playerId" text column in the schema.
--
-- Root cause: prisma/seed.ts wrote Player rows with literal ids like
-- `player-${shirtNumber}-fhsr` instead of letting `@id @default(uuid())`
-- generate one. Those literal ids propagated into the production DB and
-- now fail z.string().uuid() at POST /api/v1/training.
--
-- Strategy:
--   1. Ensure pgcrypto for gen_random_uuid().
--   2. For every FK constraint targetting "Player"(id), drop + re-add with
--      ON UPDATE CASCADE so updating Player.id propagates to children.
--   3. Build a temp map (old_id → new_uuid) for every Player whose id is
--      not UUID-shaped, update "Player".id (cascades the real FKs), then
--      apply the same remap to every other column literally named
--      "playerId" — captures the ~40 orphan string refs the schema has
--      (`playerId String?` without an @relation), which aren't covered by
--      cascade.
--   4. Drop the temp map.
--
-- Idempotent: re-running finds no non-UUID Player rows and is a no-op.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Step 1: switch every FK on "Player"(id) to ON UPDATE CASCADE ───────────
DO $$
DECLARE
  fk RECORD;
  delete_action TEXT;
BEGIN
  FOR fk IN
    SELECT
      con.conname        AS constraint_name,
      cl.relname         AS table_name,
      att.attname        AS column_name,
      con.confdeltype    AS delete_type
    FROM pg_constraint con
    JOIN pg_class cl        ON cl.oid = con.conrelid
    JOIN pg_class cl_ref    ON cl_ref.oid = con.confrelid
    JOIN pg_attribute att   ON att.attrelid = cl.oid AND att.attnum = ANY (con.conkey)
    JOIN pg_attribute attr  ON attr.attrelid = cl_ref.oid AND attr.attnum = ANY (con.confkey)
    WHERE con.contype = 'f'
      AND cl_ref.relname = 'Player'
      AND attr.attname  = 'id'
      AND con.confupdtype <> 'c'   -- not already ON UPDATE CASCADE
  LOOP
    delete_action := CASE fk.delete_type
      WHEN 'c' THEN 'CASCADE'
      WHEN 'n' THEN 'SET NULL'
      WHEN 'd' THEN 'SET DEFAULT'
      WHEN 'r' THEN 'RESTRICT'
      ELSE          'NO ACTION'
    END;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.table_name, fk.constraint_name);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES "Player"("id") ON DELETE %s ON UPDATE CASCADE',
      fk.table_name, fk.constraint_name, fk.column_name, delete_action
    );
  END LOOP;
END $$;

-- ── Step 2: build the old → new id map for non-UUID Player rows ────────────
DROP TABLE IF EXISTS _player_id_remap;
CREATE TEMP TABLE _player_id_remap (
  old_id TEXT PRIMARY KEY,
  new_id TEXT NOT NULL UNIQUE
);

INSERT INTO _player_id_remap (old_id, new_id)
SELECT id, gen_random_uuid()::text
FROM "Player"
WHERE id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- ── Step 3: update Player.id (real FKs cascade automatically) ──────────────
UPDATE "Player" p
SET id = m.new_id
FROM _player_id_remap m
WHERE p.id = m.old_id;

-- ── Step 4: sweep every other "playerId" column (orphan string refs) ───────
-- Real FKs already cascaded in step 3, so those rows hold new_id and won't
-- match m.old_id below. Columns without a FK still hold old_id and get
-- remapped here. Skips the "Player" table itself (it has no playerId column).
DO $$
DECLARE
  col RECORD;
BEGIN
  FOR col IN
    SELECT c.table_schema, c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.column_name = 'playerId'
      AND c.table_schema = current_schema()
      AND c.table_name <> 'Player'
  LOOP
    EXECUTE format(
      'UPDATE %I.%I t SET %I = m.new_id FROM _player_id_remap m WHERE t.%I = m.old_id',
      col.table_schema, col.table_name, col.column_name, col.column_name
    );
  END LOOP;
END $$;

DROP TABLE IF EXISTS _player_id_remap;
