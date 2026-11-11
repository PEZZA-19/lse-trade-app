-- Removing the last person from an Assigned job steps it back to Unassigned (new history cause).
ALTER TABLE job_history DROP CONSTRAINT job_history_cause_check;
ALTER TABLE job_history ADD CONSTRAINT job_history_cause_check
  CHECK (cause IN ('created', 'created_from_quote', 'manual', 'assigned', 'last_unassigned',
                   'appointment_created', 'appointment_deleted', 'timer_started', 'invoiced_and_paid'));
