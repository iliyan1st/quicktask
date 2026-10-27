-- QuickTask Database Schema for Supabase
-- Run this in the Supabase SQL Editor to set up your database

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- USERS / PROFILES
-- ============================================
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username TEXT UNIQUE NOT NULL,
  full_name TEXT NOT NULL,
  avatar_url TEXT,
  phone TEXT,
  email TEXT,
  bio TEXT,
  location TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  trust_level TEXT NOT NULL DEFAULT 'new' CHECK (trust_level IN ('new', 'verified', 'active', 'trusted', 'premium')),
  email_verified BOOLEAN DEFAULT FALSE,
  phone_verified BOOLEAN DEFAULT FALSE,
  tasks_completed INTEGER DEFAULT 0,
  tasks_posted INTEGER DEFAULT 0,
  rating_avg NUMERIC(3,2) DEFAULT 0,
  rating_count INTEGER DEFAULT 0,
  wallet_balance NUMERIC(10,2) DEFAULT 0,
  wallet_held NUMERIC(10,2) DEFAULT 0,
  payment_mode TEXT DEFAULT 'cash' CHECK (payment_mode IN ('cash', 'escrow')),
  is_premium BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- TASKS
-- ============================================
CREATE TABLE tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  poster_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('home-repair', 'cleaning', 'delivery', 'errands', 'moving', 'tech-help', 'plumbing', 'electrical', 'painting', 'gardening', 'pet-care', 'tutoring', 'beauty', 'other')),
  price NUMERIC(10,2) NOT NULL,
  bidding_type TEXT NOT NULL CHECK (bidding_type IN ('price', 'fixed')),
  payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash', 'escrow')),
  location TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  photos TEXT[] DEFAULT '{}',
  bidding_duration_hours INTEGER NOT NULL DEFAULT 24,
  selection_duration_hours INTEGER NOT NULL DEFAULT 3,
  bidding_ends_at TIMESTAMPTZ NOT NULL,
  selection_ends_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'selecting', 'in_progress', 'completed', 'cancelled', 'expired')),
  selected_bid_id UUID,
  selected_doer_id UUID REFERENCES profiles(id),
  completed_at TIMESTAMPTZ,
  bid_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- BIDS
-- ============================================
CREATE TABLE bids (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  bidder_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  amount NUMERIC(10,2),  -- NULL for fixed-price tasks
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'selected', 'rejected', 'withdrawn')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, bidder_id)
);

-- ============================================
-- MESSAGES / CONVERSATIONS
-- ============================================
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  poster_id UUID NOT NULL REFERENCES profiles(id),
  doer_id UUID NOT NULL REFERENCES profiles(id),
  is_unlocked BOOLEAN DEFAULT FALSE,
  agreed_price NUMERIC(10,2),
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, poster_id, doer_id)
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES profiles(id),
  content TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- RATINGS / REVIEWS
-- ============================================
CREATE TABLE ratings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rater_id UUID NOT NULL REFERENCES profiles(id),
  rated_id UUID NOT NULL REFERENCES profiles(id),
  score INTEGER NOT NULL CHECK (score >= 1 AND score <= 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(task_id, rater_id)
);

-- ============================================
-- WALLET TRANSACTIONS
-- ============================================
CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id),
  type TEXT NOT NULL CHECK (type IN ('deposit', 'held', 'released', 'received', 'withdrawal', 'refund')),
  amount NUMERIC(10,2) NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- NOTIFICATIONS
-- ============================================
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES for performance
-- ============================================
CREATE INDEX idx_tasks_poster ON tasks(poster_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_category ON tasks(category);
CREATE INDEX idx_tasks_bidding_ends ON tasks(bidding_ends_at);
CREATE INDEX idx_tasks_location ON tasks(latitude, longitude);
CREATE INDEX idx_bids_task ON bids(task_id);
CREATE INDEX idx_bids_bidder ON bids(bidder_id);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_conversations_poster ON conversations(poster_id);
CREATE INDEX idx_conversations_doer ON conversations(doer_id);
CREATE INDEX idx_transactions_user ON transactions(user_id);
CREATE INDEX idx_notifications_user ON notifications(user_id, is_read);

-- ============================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================

-- Profiles: anyone can read, only owner can update
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Profiles are viewable by everyone"
  ON profiles FOR SELECT USING (true);

CREATE POLICY "Users can update own profile"
  ON profiles FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Tasks: anyone can read, only poster can update/delete
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Tasks are viewable by everyone"
  ON tasks FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create tasks"
  ON tasks FOR INSERT WITH CHECK (auth.uid() = poster_id);

CREATE POLICY "Poster can update own tasks"
  ON tasks FOR UPDATE USING (auth.uid() = poster_id);

-- Bids: task poster and bidder can see bids, bidder can create
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Bids viewable by task poster and bidder"
  ON bids FOR SELECT USING (
    auth.uid() = bidder_id OR
    auth.uid() IN (SELECT poster_id FROM tasks WHERE id = task_id)
  );

CREATE POLICY "Authenticated users can create bids"
  ON bids FOR INSERT WITH CHECK (auth.uid() = bidder_id);

CREATE POLICY "Bidder can update own bids"
  ON bids FOR UPDATE USING (auth.uid() = bidder_id);

-- Conversations: only participants can see
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Conversations viewable by participants"
  ON conversations FOR SELECT USING (
    auth.uid() = poster_id OR auth.uid() = doer_id
  );

CREATE POLICY "System can create conversations"
  ON conversations FOR INSERT WITH CHECK (
    auth.uid() = poster_id OR auth.uid() = doer_id
  );

-- Messages: only conversation participants can see/create
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Messages viewable by conversation participants"
  ON messages FOR SELECT USING (
    auth.uid() IN (
      SELECT poster_id FROM conversations WHERE id = conversation_id
      UNION
      SELECT doer_id FROM conversations WHERE id = conversation_id
    )
  );

CREATE POLICY "Participants can send messages"
  ON messages FOR INSERT WITH CHECK (
    auth.uid() = sender_id AND
    auth.uid() IN (
      SELECT poster_id FROM conversations WHERE id = conversation_id
      UNION
      SELECT doer_id FROM conversations WHERE id = conversation_id
    )
  );

-- Ratings: anyone can read, only rater can create
ALTER TABLE ratings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ratings are viewable by everyone"
  ON ratings FOR SELECT USING (true);

CREATE POLICY "Authenticated users can create ratings"
  ON ratings FOR INSERT WITH CHECK (auth.uid() = rater_id);

-- Transactions: only owner can see
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own transactions"
  ON transactions FOR SELECT USING (auth.uid() = user_id);

-- Notifications: only owner can see/update
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- ============================================
-- FUNCTIONS & TRIGGERS
-- ============================================

-- Auto-create profile on user signup
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO profiles (id, username, full_name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'username', split_part(NEW.email, '@', 1)),
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- Update bid count on task when bid is created
CREATE OR REPLACE FUNCTION update_bid_count()
RETURNS TRIGGER AS $$
DECLARE
  tid UUID := COALESCE(NEW.task_id, OLD.task_id);
BEGIN
  UPDATE tasks SET bid_count = (
    SELECT COUNT(*) FROM bids WHERE task_id = tid AND status != 'withdrawn'
  ), updated_at = NOW()
  WHERE id = tid;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_bid_change
  AFTER INSERT OR UPDATE OR DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION update_bid_count();

-- Update user rating when new rating is added
CREATE OR REPLACE FUNCTION update_user_rating()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE profiles SET
    rating_avg = (SELECT AVG(score) FROM ratings WHERE rated_id = NEW.rated_id),
    rating_count = (SELECT COUNT(*) FROM ratings WHERE rated_id = NEW.rated_id),
    updated_at = NOW()
  WHERE id = NEW.rated_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_rating_created
  AFTER INSERT ON ratings
  FOR EACH ROW EXECUTE FUNCTION update_user_rating();

-- Update trust level based on activity
CREATE OR REPLACE FUNCTION update_trust_level()
RETURNS TRIGGER AS $$
BEGIN
  NEW.trust_level := CASE
    WHEN NEW.is_premium THEN 'premium'
    WHEN NEW.tasks_completed >= 20 AND NEW.rating_avg >= 4.5 THEN 'trusted'
    WHEN NEW.tasks_completed >= 5 AND NEW.rating_avg >= 4.0 THEN 'active'
    WHEN NEW.email_verified AND NEW.phone_verified THEN 'verified'
    ELSE 'new'
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER before_profile_update
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_trust_level();

-- Auto-transition task to 'selecting' when bidding ends
-- (This would be run by a Supabase Edge Function on a cron schedule)

-- Updated_at trigger for all tables
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER set_updated_at BEFORE UPDATE ON bids FOR EACH ROW EXECUTE FUNCTION update_updated_at();
