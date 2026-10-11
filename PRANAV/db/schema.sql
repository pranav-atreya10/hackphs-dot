-- SkySentry detections schema for Tiger Data (TimescaleDB), per the team build plan (section 4).
-- Apply with: npm run db:setup   (statements run one at a time; continuous aggregates can't run in a transaction)

-- One row per camera event relayed by server.js. Snapshots are not stored here (they go to MongoDB with incidents).
CREATE TABLE IF NOT EXISTS detections (
  time         TIMESTAMPTZ NOT NULL DEFAULT now(),
  camera_id    TEXT,
  type         TEXT,  -- 'bird' or 'drone'
  object_count INT,
  direction    TEXT,
  confidence   REAL,
  risk         TEXT   -- 'green', 'yellow', or 'red'
);

SELECT create_hypertable('detections', by_range('time'), if_not_exists => TRUE);

-- Events and objects per type per hour, read by GET /api/hourly and the tower charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS detections_hourly
WITH (timescaledb.continuous, timescaledb.materialized_only = false) AS
SELECT time_bucket('1 hour', time) AS hour, type,
       count(*) AS events, sum(object_count) AS total_objects
FROM detections
GROUP BY hour, type
WITH NO DATA;

-- Materialize every minute; the newest data is computed live (materialized_only = false).
SELECT add_continuous_aggregate_policy('detections_hourly',
  start_offset      => INTERVAL '1 day',
  end_offset        => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists     => TRUE);

-- One row per Gemini bird-judge verdict (POST /api/verify-bird and incident analysis), for accuracy-over-time charts.
CREATE TABLE IF NOT EXISTS bird_checks (
  time       TIMESTAMPTZ NOT NULL DEFAULT now(),
  airport    TEXT,
  verdict    TEXT,  -- 'bird', 'not_bird' or 'uncertain'
  confidence REAL,
  source     TEXT   -- 'gemini' or 'fallback'
);

SELECT create_hypertable('bird_checks', by_range('time'), if_not_exists => TRUE);
