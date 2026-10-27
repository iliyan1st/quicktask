-- Additional RPC functions for QuickTask
-- Run this AFTER schema.sql in the Supabase SQL Editor

-- Increment tasks_posted counter
CREATE OR REPLACE FUNCTION increment_tasks_posted(user_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles SET tasks_posted = tasks_posted + 1 WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Get nearby tasks using PostGIS-like distance calculation
-- (Using Haversine formula since PostGIS extension may not be available on free tier)
CREATE OR REPLACE FUNCTION get_nearby_tasks(
  user_lat DOUBLE PRECISION,
  user_lng DOUBLE PRECISION,
  radius_km DOUBLE PRECISION DEFAULT 50,
  task_status TEXT DEFAULT 'open'
)
RETURNS TABLE (
  id UUID,
  title TEXT,
  description TEXT,
  category TEXT,
  price NUMERIC,
  bidding_type TEXT,
  location TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  bidding_ends_at TIMESTAMPTZ,
  bid_count INTEGER,
  poster_id UUID,
  distance_km DOUBLE PRECISION
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id, t.title, t.description, t.category, t.price,
    t.bidding_type, t.location, t.latitude, t.longitude,
    t.bidding_ends_at, t.bid_count, t.poster_id,
    (6371 * acos(
      cos(radians(user_lat)) * cos(radians(t.latitude)) *
      cos(radians(t.longitude) - radians(user_lng)) +
      sin(radians(user_lat)) * sin(radians(t.latitude))
    )) AS distance_km
  FROM tasks t
  WHERE t.status = task_status
    AND t.latitude IS NOT NULL
    AND t.longitude IS NOT NULL
    AND (6371 * acos(LEAST(1.0, GREATEST(-1.0,
      cos(radians(user_lat)) * cos(radians(t.latitude)) *
      cos(radians(t.longitude) - radians(user_lng)) +
      sin(radians(user_lat)) * sin(radians(t.latitude))
    )))) <= radius_km
  ORDER BY distance_km ASC;
END;
$$ LANGUAGE plpgsql;

-- Get dashboard stats for a user
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  result JSON;
BEGIN
  SELECT json_build_object(
    'tasks_posted', (SELECT COUNT(*) FROM tasks WHERE poster_id = p_user_id),
    'tasks_completed_as_poster', (SELECT COUNT(*) FROM tasks WHERE poster_id = p_user_id AND status = 'completed'),
    'tasks_completed_as_doer', (SELECT COUNT(*) FROM tasks WHERE selected_doer_id = p_user_id AND status = 'completed'),
    'active_bids', (SELECT COUNT(*) FROM bids WHERE bidder_id = p_user_id AND status = 'pending'),
    'total_earned', (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = p_user_id AND type = 'received'),
    'total_spent', (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = p_user_id AND type IN ('released', 'held'))
  ) INTO result;
  RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
