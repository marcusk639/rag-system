CREATE UNIQUE INDEX IF NOT EXISTS sca_user_client_unique
  ON staff_client_assignments (user_id, client_id);
