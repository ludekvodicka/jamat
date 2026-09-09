-- SQL sample: keyword, string and comment colouring.
CREATE TABLE IF NOT EXISTS session_records (
  id           uuid PRIMARY KEY,
  project_id   uuid NOT NULL,
  agent        text NOT NULL CHECK (agent IN ('claude', 'codex')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  exit_code    integer
);

SELECT p.name AS project,
       count(*) FILTER (WHERE s.exit_code = 0) AS finished,
       count(*) FILTER (WHERE s.exit_code IS NULL) AS running
FROM session_records s
JOIN projects p ON p.id = s.project_id
WHERE s.created_at > now() - interval '30 days'
GROUP BY p.name
HAVING count(*) > 1
ORDER BY finished DESC;
