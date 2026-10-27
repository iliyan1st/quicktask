-- QuickTask migration 2026-10-27
-- Run after schema.sql and functions.sql. Supersedes fix_runtime.sql. Safe to re-run.
--
-- The browser talks to Supabase directly, so the database is the backend.
-- Clients may only insert tasks, bids and messages and edit harmless profile
-- fields. Every state change (select a bid, complete, cancel, withdraw, rate,
-- top up) goes through a SECURITY DEFINER function that checks the caller.
-- Errors are raised as short keys (e.g. 'insufficient_funds') that the
-- frontend translates.

-- ============================================
-- CONSTRAINTS
-- ============================================
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_price_range;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_price_range CHECK (price > 0 AND price <= 100000);
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_text_length;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_text_length
  CHECK (char_length(title) BETWEEN 3 AND 120 AND char_length(description) BETWEEN 1 AND 4000);
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_duration_range;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_duration_range
  CHECK (bidding_duration_hours BETWEEN 1 AND 168 AND selection_duration_hours BETWEEN 1 AND 24);
ALTER TABLE public.tasks DROP CONSTRAINT IF EXISTS tasks_photos_max;
ALTER TABLE public.tasks ADD CONSTRAINT tasks_photos_max CHECK (cardinality(photos) <= 5);
ALTER TABLE public.bids DROP CONSTRAINT IF EXISTS bids_amount_range;
ALTER TABLE public.bids ADD CONSTRAINT bids_amount_range CHECK (amount IS NULL OR (amount > 0 AND amount <= 100000));
ALTER TABLE public.bids DROP CONSTRAINT IF EXISTS bids_message_length;
ALTER TABLE public.bids ADD CONSTRAINT bids_message_length CHECK (message IS NULL OR char_length(message) <= 1000);
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_content_length;
ALTER TABLE public.messages ADD CONSTRAINT messages_content_length CHECK (char_length(content) BETWEEN 1 AND 2000);
ALTER TABLE public.ratings DROP CONSTRAINT IF EXISTS ratings_comment_length;
ALTER TABLE public.ratings ADD CONSTRAINT ratings_comment_length CHECK (comment IS NULL OR char_length(comment) <= 1000);
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_wallet_nonnegative;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_wallet_nonnegative CHECK (wallet_balance >= 0 AND wallet_held >= 0);

-- ============================================
-- TABLE PRIVILEGES
-- Supabase grants everything to anon/authenticated by default and relies on
-- RLS alone. Narrow that down so a policy mistake can't expose a column.
-- ============================================
REVOKE ALL ON public.profiles, public.tasks, public.bids, public.conversations,
  public.messages, public.ratings, public.transactions, public.notifications
  FROM anon, authenticated;

-- Profiles: public columns only. Email, phone, location and wallet stay private
-- and are read through get_my_profile().
GRANT SELECT (id, username, full_name, avatar_url, bio, trust_level, email_verified,
  phone_verified, tasks_completed, tasks_posted, rating_avg, rating_count, is_premium, created_at)
  ON public.profiles TO anon, authenticated;
GRANT UPDATE (username, full_name, avatar_url, phone, bio, location) ON public.profiles TO authenticated;

GRANT SELECT ON public.tasks TO anon, authenticated;
GRANT INSERT (poster_id, title, description, category, price, bidding_type, payment_method,
  location, latitude, longitude, photos, bidding_duration_hours, selection_duration_hours, bidding_ends_at)
  ON public.tasks TO authenticated;

GRANT SELECT ON public.bids TO authenticated;
GRANT INSERT (task_id, bidder_id, amount, message) ON public.bids TO authenticated;

GRANT SELECT ON public.conversations TO authenticated;

GRANT SELECT ON public.messages TO authenticated;
GRANT INSERT (conversation_id, sender_id, content) ON public.messages TO authenticated;
GRANT UPDATE (is_read) ON public.messages TO authenticated;

GRANT SELECT ON public.ratings TO anon, authenticated;
GRANT SELECT ON public.transactions TO authenticated;
GRANT SELECT ON public.notifications TO authenticated;
GRANT UPDATE (is_read) ON public.notifications TO authenticated;

-- ============================================
-- RLS POLICIES
-- ============================================
DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
DROP POLICY IF EXISTS "Poster can update own tasks" ON public.tasks;
DROP POLICY IF EXISTS "Bidder can update own bids" ON public.bids;
DROP POLICY IF EXISTS "Poster can update bids on own tasks" ON public.bids;
DROP POLICY IF EXISTS "System can create conversations" ON public.conversations;
DROP POLICY IF EXISTS "Participants can update conversations" ON public.conversations;
DROP POLICY IF EXISTS "Participants can update messages" ON public.messages;
DROP POLICY IF EXISTS "Authenticated users can create ratings" ON public.ratings;

DROP POLICY IF EXISTS "Participants can send messages" ON public.messages;
CREATE POLICY "Participants can send messages"
  ON public.messages FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND c.is_unlocked AND auth.uid() IN (c.poster_id, c.doer_id)
    )
  );

DROP POLICY IF EXISTS "Recipients can mark messages read" ON public.messages;
CREATE POLICY "Recipients can mark messages read"
  ON public.messages FOR UPDATE TO authenticated
  USING (
    sender_id <> auth.uid() AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND auth.uid() IN (c.poster_id, c.doer_id)
    )
  );

-- ============================================
-- HELPERS
-- ============================================
CREATE OR REPLACE FUNCTION public.qt_notify(p_user UUID, p_type TEXT, p_title TEXT, p_data JSONB)
RETURNS VOID
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  INSERT INTO notifications (user_id, type, title, data)
  VALUES (p_user, p_type, p_title, COALESCE(p_data, '{}'::jsonb));
$$;

CREATE OR REPLACE FUNCTION public.get_my_profile()
RETURNS public.profiles
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT * FROM profiles WHERE id = auth.uid();
$$;

-- ============================================
-- SIGNUP / EMAIL
-- ============================================
-- A taken username used to make signup fail with "Database error saving new
-- user"; now a number is appended instead.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  base TEXT;
  uname TEXT;
  n INT := 0;
BEGIN
  base := left(regexp_replace(
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'username', ''), split_part(NEW.email, '@', 1)),
    '[^[:alnum:]_.]', '', 'g'), 24);
  IF base = '' THEN base := 'user'; END IF;
  uname := base;
  WHILE EXISTS (SELECT 1 FROM profiles WHERE lower(username) = lower(uname)) LOOP
    n := n + 1;
    uname := base || n::text;
  END LOOP;

  INSERT INTO profiles (id, username, full_name, email, avatar_url, email_verified)
  VALUES (
    NEW.id,
    uname,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), NULLIF(NEW.raw_user_meta_data->>'name', ''), split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url',
    NEW.email_confirmed_at IS NOT NULL
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_user_updated()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE profiles
  SET email = NEW.email, email_verified = NEW.email_confirmed_at IS NOT NULL
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF email, email_confirmed_at ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_user_updated();

-- ============================================
-- TASKS
-- ============================================
-- Server decides status, counters and deadlines; the client only describes the task.
CREATE OR REPLACE FUNCTION public.tasks_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  p TEXT;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    NEW.poster_id := auth.uid();
    NEW.status := 'open';
    NEW.bid_count := 0;
    NEW.selected_bid_id := NULL;
    NEW.selected_doer_id := NULL;
    NEW.completed_at := NULL;
    NEW.selection_ends_at := NULL;
    NEW.created_at := NOW();
    NEW.bidding_ends_at := NOW() + make_interval(hours => NEW.bidding_duration_hours);
    -- Photos are storage paths inside the poster's own folder of the task-photos bucket.
    FOREACH p IN ARRAY COALESCE(NEW.photos, '{}') LOOP
      IF p IS NULL OR p !~ ('^' || auth.uid()::text || '/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$') THEN
        RAISE EXCEPTION 'invalid_photo';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_task_insert ON public.tasks;
CREATE TRIGGER before_task_insert
  BEFORE INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_before_insert();

CREATE OR REPLACE FUNCTION public.tasks_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE profiles SET tasks_posted = COALESCE(tasks_posted, 0) + 1 WHERE id = NEW.poster_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS after_task_insert ON public.tasks;
CREATE TRIGGER after_task_insert
  AFTER INSERT ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.tasks_after_insert();

-- ============================================
-- BIDS
-- ============================================
CREATE OR REPLACE FUNCTION public.bids_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;
  IF auth.uid() IS NOT NULL THEN
    NEW.bidder_id := auth.uid();
    IF t.poster_id = auth.uid() THEN RAISE EXCEPTION 'own_task'; END IF;
    IF t.status <> 'open' OR t.bidding_ends_at <= NOW() THEN RAISE EXCEPTION 'bidding_closed'; END IF;
  END IF;
  NEW.status := 'pending';
  IF t.bidding_type = 'fixed' THEN
    NEW.amount := t.price;
  ELSIF NEW.amount IS NULL OR NEW.amount <= 0 THEN
    RAISE EXCEPTION 'invalid_amount';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS before_bid_insert ON public.bids;
CREATE TRIGGER before_bid_insert
  BEFORE INSERT ON public.bids
  FOR EACH ROW EXECUTE FUNCTION public.bids_before_insert();

CREATE OR REPLACE FUNCTION public.bids_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = NEW.task_id;
  PERFORM qt_notify(t.poster_id, 'new_bid', 'New bid on your task',
    jsonb_build_object('task_id', t.id, 'task_title', t.title, 'amount', NEW.amount));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS after_bid_insert ON public.bids;
CREATE TRIGGER after_bid_insert
  AFTER INSERT ON public.bids
  FOR EACH ROW EXECUTE FUNCTION public.bids_after_insert();

-- ============================================
-- MESSAGES
-- ============================================
CREATE OR REPLACE FUNCTION public.messages_after_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE conversations SET last_message_at = NEW.created_at WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS after_message_insert ON public.messages;
CREATE TRIGGER after_message_insert
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.messages_after_insert();

-- ============================================
-- WORKFLOW RPCs
-- ============================================

-- Poster picks a bid. For escrow tasks the agreed amount moves from the
-- poster's available balance to held.
CREATE OR REPLACE FUNCTION public.select_bid(p_bid_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  b bids%ROWTYPE;
  t tasks%ROWTYPE;
  agreed NUMERIC;
BEGIN
  -- Lock the bid so a concurrent withdraw_bid waits and then finds it no longer pending.
  SELECT * INTO b FROM bids WHERE id = p_bid_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'bid_not_found'; END IF;
  SELECT * INTO t FROM tasks WHERE id = b.task_id FOR UPDATE;
  IF t.poster_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'not_your_task'; END IF;
  IF t.status NOT IN ('open', 'selecting') THEN RAISE EXCEPTION 'task_not_open'; END IF;
  IF b.status <> 'pending' THEN RAISE EXCEPTION 'bid_not_pending'; END IF;

  agreed := COALESCE(b.amount, t.price);

  IF t.payment_method = 'escrow' THEN
    UPDATE profiles
    SET wallet_balance = wallet_balance - agreed, wallet_held = wallet_held + agreed
    WHERE id = t.poster_id AND wallet_balance >= agreed;
    IF NOT FOUND THEN RAISE EXCEPTION 'insufficient_funds'; END IF;
    INSERT INTO transactions (user_id, task_id, type, amount, description)
    VALUES (t.poster_id, t.id, 'held', agreed, 'Held for: ' || t.title);
  END IF;

  UPDATE tasks
  SET status = 'in_progress', selected_bid_id = b.id, selected_doer_id = b.bidder_id
  WHERE id = t.id;

  UPDATE bids SET status = 'selected' WHERE id = b.id;

  INSERT INTO conversations (task_id, poster_id, doer_id, is_unlocked, agreed_price)
  VALUES (t.id, t.poster_id, b.bidder_id, TRUE, agreed)
  ON CONFLICT (task_id, poster_id, doer_id)
  DO UPDATE SET is_unlocked = TRUE, agreed_price = EXCLUDED.agreed_price;

  PERFORM qt_notify(b.bidder_id, 'bid_selected', 'Your bid was selected',
    jsonb_build_object('task_id', t.id, 'task_title', t.title, 'amount', agreed));

  WITH rejected AS (
    UPDATE bids SET status = 'rejected'
    WHERE task_id = t.id AND id <> b.id AND status = 'pending'
    RETURNING bidder_id
  )
  INSERT INTO notifications (user_id, type, title, data)
  SELECT bidder_id, 'bid_rejected', 'Another bidder was selected',
    jsonb_build_object('task_id', t.id, 'task_title', t.title)
  FROM rejected;
END;
$$;

-- Poster confirms the work is done. Escrow is released only if it was
-- actually held for this task (older escrow tasks never held anything).
CREATE OR REPLACE FUNCTION public.complete_task(p_task_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
  agreed NUMERIC;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;
  IF t.poster_id IS DISTINCT FROM auth.uid() THEN RAISE EXCEPTION 'not_your_task'; END IF;
  IF t.status <> 'in_progress' THEN RAISE EXCEPTION 'task_not_in_progress'; END IF;

  SELECT COALESCE(amount, t.price) INTO agreed FROM bids WHERE id = t.selected_bid_id;
  agreed := COALESCE(agreed, t.price);

  UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = t.id;
  UPDATE profiles SET tasks_completed = COALESCE(tasks_completed, 0) + 1 WHERE id = t.selected_doer_id;

  IF t.payment_method = 'escrow' AND EXISTS (
    SELECT 1 FROM transactions WHERE task_id = t.id AND type = 'held' AND user_id = t.poster_id
  ) THEN
    UPDATE profiles SET wallet_held = GREATEST(0, wallet_held - agreed) WHERE id = t.poster_id;
    UPDATE profiles SET wallet_balance = wallet_balance + agreed WHERE id = t.selected_doer_id;
    INSERT INTO transactions (user_id, task_id, type, amount, description) VALUES
      (t.poster_id, t.id, 'released', agreed, 'Payment released for: ' || t.title),
      (t.selected_doer_id, t.id, 'received', agreed, 'Payment received for: ' || t.title);
  END IF;

  PERFORM qt_notify(t.selected_doer_id, 'task_completed', 'Task marked complete',
    jsonb_build_object('task_id', t.id, 'task_title', t.title, 'amount', agreed, 'payment_method', t.payment_method));
END;
$$;

-- Cancel a task.
--   * The poster may cancel before a doer is chosen; pending bidders are told.
--   * Once in progress, only the doer may back out. Held escrow goes back to
--     the poster.
CREATE OR REPLACE FUNCTION public.cancel_task(p_task_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
  held NUMERIC;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = p_task_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;

  IF auth.uid() = t.poster_id AND t.status IN ('open', 'selecting') THEN
    UPDATE tasks SET status = 'cancelled' WHERE id = t.id;
    WITH rejected AS (
      UPDATE bids SET status = 'rejected'
      WHERE task_id = t.id AND status = 'pending'
      RETURNING bidder_id
    )
    INSERT INTO notifications (user_id, type, title, data)
    SELECT bidder_id, 'task_cancelled', 'A task you bid on was cancelled',
      jsonb_build_object('task_id', t.id, 'task_title', t.title)
    FROM rejected;

  ELSIF auth.uid() = t.selected_doer_id AND t.status = 'in_progress' THEN
    UPDATE tasks SET status = 'cancelled' WHERE id = t.id;
    UPDATE bids SET status = 'withdrawn' WHERE id = t.selected_bid_id;

    SELECT amount INTO held FROM transactions
    WHERE task_id = t.id AND type = 'held' AND user_id = t.poster_id
    ORDER BY created_at DESC LIMIT 1;
    IF t.payment_method = 'escrow' AND held IS NOT NULL THEN
      UPDATE profiles
      SET wallet_held = GREATEST(0, wallet_held - held), wallet_balance = wallet_balance + held
      WHERE id = t.poster_id;
      INSERT INTO transactions (user_id, task_id, type, amount, description)
      VALUES (t.poster_id, t.id, 'refund', held, 'Refund for: ' || t.title);
    END IF;

    PERFORM qt_notify(t.poster_id, 'doer_withdrew', 'The doer backed out',
      jsonb_build_object('task_id', t.id, 'task_title', t.title));
  ELSE
    RAISE EXCEPTION 'cannot_cancel';
  END IF;
END;
$$;

-- Bidder takes back a bid that hasn't been decided yet.
CREATE OR REPLACE FUNCTION public.withdraw_bid(p_bid_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  UPDATE bids b SET status = 'withdrawn'
  FROM tasks t
  WHERE b.id = p_bid_id AND t.id = b.task_id
    AND b.bidder_id = auth.uid() AND b.status = 'pending'
    AND t.status IN ('open', 'selecting');
  IF NOT FOUND THEN RAISE EXCEPTION 'cannot_withdraw'; END IF;
END;
$$;

-- Poster and doer rate each other once per completed task.
CREATE OR REPLACE FUNCTION public.rate_task(p_task_id UUID, p_score INT, p_comment TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
  v_rated UUID;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = p_task_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'task_not_found'; END IF;
  IF t.status <> 'completed' THEN RAISE EXCEPTION 'task_not_completed'; END IF;
  IF auth.uid() = t.poster_id THEN v_rated := t.selected_doer_id;
  ELSIF auth.uid() = t.selected_doer_id THEN v_rated := t.poster_id;
  ELSE RAISE EXCEPTION 'not_a_participant';
  END IF;
  IF v_rated IS NULL THEN RAISE EXCEPTION 'not_a_participant'; END IF;
  IF p_score IS NULL OR p_score NOT BETWEEN 1 AND 5 THEN RAISE EXCEPTION 'invalid_score'; END IF;
  IF EXISTS (SELECT 1 FROM ratings WHERE task_id = t.id AND rater_id = auth.uid()) THEN
    RAISE EXCEPTION 'already_rated';
  END IF;

  INSERT INTO ratings (task_id, rater_id, rated_id, score, comment)
  VALUES (t.id, auth.uid(), v_rated, p_score, NULLIF(btrim(p_comment), ''));

  PERFORM qt_notify(v_rated, 'new_rating', 'You received a rating',
    jsonb_build_object('task_id', t.id, 'task_title', t.title, 'score', p_score));
END;
$$;

-- Demo wallet: test credits only, no real money moves.
CREATE OR REPLACE FUNCTION public.demo_top_up(p_amount NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF p_amount IS NULL OR p_amount < 5 OR p_amount > 500 THEN RAISE EXCEPTION 'invalid_amount'; END IF;
  UPDATE profiles SET wallet_balance = wallet_balance + p_amount
  WHERE id = auth.uid() AND wallet_balance + p_amount <= 5000
  RETURNING wallet_balance INTO v_balance;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet_limit'; END IF;
  INSERT INTO transactions (user_id, type, amount, description)
  VALUES (auth.uid(), 'deposit', p_amount, 'Test credits');
  RETURN v_balance;
END;
$$;

-- ============================================
-- SCHEDULED STATUS CHANGES (pg_cron, every 5 minutes)
-- Replaces api/cron/update-tasks.js. Nothing is held before a bid is
-- selected, so expiring a task never has escrow to refund.
-- ============================================
CREATE OR REPLACE FUNCTION public.expire_tasks()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Bidding ended with bids: the poster has the selection window to choose.
  WITH moved AS (
    UPDATE tasks
    SET status = 'selecting', selection_ends_at = NOW() + make_interval(hours => selection_duration_hours)
    WHERE status = 'open' AND bidding_ends_at <= NOW() AND bid_count > 0
    RETURNING id, poster_id, title
  )
  INSERT INTO notifications (user_id, type, title, data)
  SELECT poster_id, 'selection_needed', 'Bidding ended - choose a doer',
    jsonb_build_object('task_id', id, 'task_title', title)
  FROM moved;

  -- Bidding ended with no bids.
  WITH gone AS (
    UPDATE tasks SET status = 'expired'
    WHERE status = 'open' AND bidding_ends_at <= NOW() AND bid_count = 0
    RETURNING id, poster_id, title
  )
  INSERT INTO notifications (user_id, type, title, data)
  SELECT poster_id, 'task_expired', 'Your task expired',
    jsonb_build_object('task_id', id, 'task_title', title)
  FROM gone;

  -- Selection window ran out: expire and release the waiting bidders.
  WITH gone AS (
    UPDATE tasks SET status = 'expired'
    WHERE status = 'selecting' AND selection_ends_at <= NOW()
    RETURNING id, poster_id, title
  ), rejected AS (
    UPDATE bids b SET status = 'rejected'
    FROM gone
    WHERE b.task_id = gone.id AND b.status = 'pending'
    RETURNING b.bidder_id, gone.id AS task_id, gone.title
  )
  INSERT INTO notifications (user_id, type, title, data)
  SELECT poster_id, 'task_expired', 'Your task expired',
    jsonb_build_object('task_id', id, 'task_title', title) FROM gone
  UNION ALL
  SELECT bidder_id, 'task_expired', 'A task you bid on expired',
    jsonb_build_object('task_id', task_id, 'task_title', title) FROM rejected;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.schedule('quicktask-expire-tasks', '*/5 * * * *', 'SELECT public.expire_tasks()');

-- ============================================
-- FUNCTION PRIVILEGES
-- Supabase makes every new function callable by anon; RPCs are for signed-in
-- users only, and internal helpers for nobody.
-- ============================================
DO $$
DECLARE
  fn TEXT;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.get_my_profile()', 'public.select_bid(uuid)', 'public.complete_task(uuid)',
    'public.cancel_task(uuid)', 'public.withdraw_bid(uuid)', 'public.rate_task(uuid,integer,text)',
    'public.demo_top_up(numeric)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
  END LOOP;

  FOREACH fn IN ARRAY ARRAY[
    'public.qt_notify(uuid,text,text,jsonb)', 'public.expire_tasks()',
    'public.increment_tasks_posted(uuid)', 'public.get_user_stats(uuid)',
    'public.handle_new_user()', 'public.handle_user_updated()',
    'public.tasks_before_insert()', 'public.tasks_after_insert()',
    'public.bids_before_insert()', 'public.bids_after_insert()',
    'public.messages_after_insert()', 'public.update_bid_count()', 'public.update_user_rating()'
  ] LOOP
    IF to_regprocedure(fn) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    END IF;
  END LOOP;
END $$;

-- ============================================
-- REALTIME (chat + notifications; RLS still decides who receives what)
-- ============================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
END $$;

-- ============================================
-- TASK PHOTOS (public bucket, users write only to their own folder)
-- ============================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('task-photos', 'task-photos', TRUE, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "QuickTask upload own task photos" ON storage.objects;
CREATE POLICY "QuickTask upload own task photos"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'task-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "QuickTask delete own task photos" ON storage.objects;
CREATE POLICY "QuickTask delete own task photos"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'task-photos' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================
-- BACKFILL counters that were never maintained
-- ============================================
UPDATE public.tasks t SET bid_count = (
  SELECT COUNT(*) FROM public.bids b WHERE b.task_id = t.id AND b.status <> 'withdrawn'
) WHERE bid_count IS DISTINCT FROM (
  SELECT COUNT(*) FROM public.bids b WHERE b.task_id = t.id AND b.status <> 'withdrawn'
);

UPDATE public.profiles p SET
  tasks_posted = (SELECT COUNT(*) FROM public.tasks WHERE poster_id = p.id),
  tasks_completed = (SELECT COUNT(*) FROM public.tasks WHERE selected_doer_id = p.id AND status = 'completed'),
  email_verified = COALESCE((SELECT u.email_confirmed_at IS NOT NULL FROM auth.users u WHERE u.id = p.id), FALSE);
