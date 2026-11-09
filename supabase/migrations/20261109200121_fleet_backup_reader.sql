-- Password is provisioned separately as a private secret, never in migration history.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fleet_backup') THEN
    CREATE ROLE fleet_backup NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA fleet TO fleet_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA fleet TO fleet_backup;
ALTER ROLE fleet_backup SET default_transaction_read_only = on;
DO $$ DECLARE t record; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'fleet' LOOP
    IF NOT EXISTS (SELECT FROM pg_policies WHERE schemaname='fleet' AND tablename=t.tablename AND policyname='backup_readonly') THEN
      EXECUTE format('CREATE POLICY backup_readonly ON fleet.%I FOR SELECT TO fleet_backup USING (true)', t.tablename);
    END IF;
  END LOOP;
END $$;
