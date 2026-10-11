-- Schema for camera detections on Tiger Data (TimescaleDB).
-- Apply with: npm run db:setup   (statements run one at a time; continuous aggregates can't run in a transaction)

-- One row per camera event relayed by server.js.
CREATE TABLE IF NOT EXISTS detections (
  time      timestamptz NOT NULL,
  id        uuid        NOT NULL,
  camera_id text        NOT NULL,
  payload   jsonb       NOT NULL
);

SELECT create_hypertable('detections', by_range('time'), if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS detections_camera_time_idx ON detections (camera_id, time DESC);

-- Detections per camera per hour, read by GET /api/hourly.
CREATE MATERIALIZED VIEW IF NOT EXISTS detections_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 hour', time) AS bucket,
       camera_id,
       count(*) AS detections
FROM detections
GROUP BY bucket, camera_id
WITH NO DATA;

-- Materialize closed hours every 5 minutes; the current hour is computed live (materialized_only = false).
SELECT add_continuous_aggregate_policy('detections_hourly',
  start_offset      => INTERVAL '3 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE);
