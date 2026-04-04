-- =============================================
-- TronKeeper Supabase Schema
-- =============================================
-- Run this SQL in your Supabase SQL Editor
-- =============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================
-- USERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS users (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  uid TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  usdt_balance DECIMAL(18, 8) DEFAULT 0,
  trx_balance DECIMAL(18, 8) DEFAULT 0,
  total_earned DECIMAL(18, 8) DEFAULT 0,
  wins INTEGER DEFAULT 0,
  holds_count INTEGER DEFAULT 0,
  holds_reset_at TIMESTAMPTZ,
  referred_by TEXT REFERENCES users(telegram_id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- =============================================
-- TRANSACTIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'withdraw', 'reward', 'referral')),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX')),
  amount DECIMAL(18, 8) NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'failed')),
  tx_hash TEXT,
  to_address TEXT,
  from_address TEXT,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);

-- =============================================
-- WITHDRAWALS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS withdrawals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX')),
  amount DECIMAL(18, 8) NOT NULL,
  to_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  tx_hash TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);

-- =============================================
-- REFERRALS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS referrals (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id),
  referred_id TEXT NOT NULL REFERENCES users(telegram_id),
  referred_username TEXT,
  reward_amount DECIMAL(18, 8) DEFAULT 2, -- 2 TRX per referral
  reward_asset TEXT DEFAULT 'TRX',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(referrer_id, referred_id)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);

-- =============================================
-- REFERRAL POOL TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS referral_pool (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  total_pool DECIMAL(18, 8) DEFAULT 50000,
  distributed DECIMAL(18, 8) DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert initial pool
INSERT INTO referral_pool (total_pool, distributed) 
VALUES (50000, 0)
ON CONFLICT DO NOTHING;

-- =============================================
-- CLAIMS TABLE (Hold to Earn history)
-- =============================================
CREATE TABLE IF NOT EXISTS claims (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount DECIMAL(18, 8) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_claims_user_id ON claims(user_id);
CREATE INDEX IF NOT EXISTS idx_claims_created_at ON claims(created_at DESC);

-- =============================================
-- MISSIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS missions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('daily', 'weekly', 'one_time', 'milestone')),
  reward_amount DECIMAL(18, 8) NOT NULL,
  reward_asset TEXT DEFAULT 'USDT',
  target_value INTEGER DEFAULT 1,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default missions
INSERT INTO missions (code, title, description, type, reward_amount, reward_asset, target_value) VALUES
  ('daily_hold', 'Daily Holder', 'Complete 3 holds today', 'daily', 0.10, 'USDT', 3),
  ('weekly_referral', 'Social Butterfly', 'Invite 5 friends this week', 'weekly', 0.50, 'USDT', 5),
  ('first_deposit', 'First Deposit', 'Make your first deposit', 'one_time', 1.00, 'TRX', 1),
  ('big_earner', 'Big Earner', 'Earn $10 total from holds', 'milestone', 2.00, 'USDT', 10)
ON CONFLICT (code) DO NOTHING;

-- =============================================
-- USER MISSIONS TABLE (Progress tracking)
-- =============================================
CREATE TABLE IF NOT EXISTS user_missions (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  mission_id UUID NOT NULL REFERENCES missions(id),
  progress INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  claimed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  reset_at TIMESTAMPTZ, -- For daily/weekly missions
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, mission_id)
);

-- Index
CREATE INDEX IF NOT EXISTS idx_user_missions_user_id ON user_missions(user_id);

-- =============================================
-- DEPOSITS TABLE (for tracking incoming deposits)
-- =============================================
CREATE TABLE IF NOT EXISTS deposits (
  id UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id TEXT REFERENCES users(telegram_id),
  memo TEXT NOT NULL, -- User's UID used as memo
  asset TEXT NOT NULL CHECK (asset IN ('USDT', 'TRX')),
  amount DECIMAL(18, 8) NOT NULL,
  tx_hash TEXT UNIQUE,
  from_address TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'credited')),
  credited_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index
CREATE INDEX IF NOT EXISTS idx_deposits_memo ON deposits(memo);
CREATE INDEX IF NOT EXISTS idx_deposits_tx_hash ON deposits(tx_hash);

-- =============================================
-- ROW LEVEL SECURITY (Optional but recommended)
-- =============================================
-- Note: Since we use service_role key in Worker, RLS is bypassed
-- But good to have for future direct client access if needed

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE withdrawals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_missions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;

-- =============================================
-- FUNCTION: Update timestamp
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for users table
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- =============================================
-- DONE
-- =============================================
-- After running this:
-- 1. Your tables are created
-- 2. Default missions are inserted
-- 3. Referral pool is initialized with 50,000 TRX
-- 4. Indexes are created for performance
-- =============================================
