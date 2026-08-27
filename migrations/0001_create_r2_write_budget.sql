-- R2の月間書き込み総数を数えるためのテーブル。
-- monthは "2026-08" のような "年-月" 形式の文字列（server/r2SafetyBudget.ts
-- のmonthKey()と一致させる）。1行だけを毎月アトミックに加算していく。
CREATE TABLE IF NOT EXISTS r2_write_budget (
  month TEXT PRIMARY KEY,
  writes INTEGER NOT NULL DEFAULT 0
);
