-- Create bot_characters table
CREATE TABLE IF NOT EXISTS bot_characters (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  voice_id VARCHAR(255),
  avatar_url VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_bot_characters_user_id ON bot_characters(user_id);

-- Create bot_moderations_log table
CREATE TABLE IF NOT EXISTS bot_moderations_log (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type VARCHAR(50) NOT NULL, -- 'ban', 'mute', 'kick', 'timeout', 'clear'
  target_username VARCHAR(255) NOT NULL,
  reason TEXT,
  executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(50) DEFAULT 'executed', -- 'executed', 'approved', 'rejected'
  CONSTRAINT valid_action_type CHECK (action_type IN ('ban', 'mute', 'kick', 'timeout', 'clear'))
);

-- Index for fast lookups by user
CREATE INDEX IF NOT EXISTS idx_bot_moderations_log_user_id ON bot_moderations_log(user_id);
CREATE INDEX IF NOT EXISTS idx_bot_moderations_log_executed ON bot_moderations_log(executed_at);
