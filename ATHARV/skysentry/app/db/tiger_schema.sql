-- Tiger Data (PostgreSQL + TimescaleDB): one row per detection event, plus an hourly
-- continuous aggregate for the tower charts. Build plan, section 4.
-- Run once: psql "$TIGER_DATABASE_URL" -f app/db/tiger_schema.sql
-- If a line errors, the syntax may differ slightly between TimescaleDB versions.

CREATE TABLE IF NOT EXISTS detections (
  time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  camera_id     TEXT        NOT NULL,
  type          TEXT        NOT NULL CHECK (type IN ('bird', 'drone')),
  object_count  INT         NOT NULL CHECK (object_count >= 0),
  direction     TEXT,
  confidence    REAL        CHECK (confidence BETWEEN 0 AND 1),
  risk          TEXT        NOT NULL CHECK (risk IN ('green', 'yellow', 'red'))
);

SELECT create_hypertable('detections', 'time', if_not_exists => TRUE);
CREATE INDEX IF NOT EXISTS detections_camera_time ON detections (camera_id, time DESC);
CREATE INDEX IF NOT EXISTS detections_risk_time   ON detections (risk, time DESC);

CREATE MATERIALIZED VIEW IF NOT EXISTS detections_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 hour', time) AS hour,
       type,
       count(*)                                  AS events,
       sum(object_count)                         AS total_objects,
       count(*) FILTER (WHERE risk = 'red')      AS red_events,
       count(*) FILTER (WHERE risk = 'yellow')   AS yellow_events
FROM detections
GROUP BY hour, type
WITH NO DATA;

SELECT add_continuous_aggregate_policy('detections_hourly',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- Keep 30 days of raw events; the hourly view keeps the long-term trend.
SELECT add_retention_policy('detections', INTERVAL '30 days', if_not_exists => TRUE);
