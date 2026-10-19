-- Apply on the live QuickTask database (yboawqkhjkjutzerypiv).
-- The app writes through the signed-in user, so these policies and
-- functions are what make select-bid, chat, and completion work.

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

DROP POLICY IF EXISTS "Poster can update bids on own tasks" ON bids;
CREATE POLICY "Poster can update bids on own tasks"
  ON bids FOR UPDATE
  USING (auth.uid() IN (SELECT poster_id FROM tasks WHERE id = bids.task_id))
  WITH CHECK (auth.uid() IN (SELECT poster_id FROM tasks WHERE id = bids.task_id));

DROP POLICY IF EXISTS "Participants can update conversations" ON conversations;
CREATE POLICY "Participants can update conversations"
  ON conversations FOR UPDATE
  USING (auth.uid() = poster_id OR auth.uid() = doer_id)
  WITH CHECK (auth.uid() = poster_id OR auth.uid() = doer_id);

DROP POLICY IF EXISTS "Participants can update messages" ON messages;
CREATE POLICY "Participants can update messages"
  ON messages FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT poster_id FROM conversations WHERE id = messages.conversation_id
      UNION
      SELECT doer_id FROM conversations WHERE id = messages.conversation_id
    )
  );

CREATE OR REPLACE FUNCTION complete_task(p_task_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t tasks%ROWTYPE;
  agreed NUMERIC;
BEGIN
  SELECT * INTO t FROM tasks WHERE id = p_task_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Task not found';
  END IF;
  IF t.poster_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Only the poster can complete this task';
  END IF;
  IF t.status IS DISTINCT FROM 'in_progress' THEN
    RAISE EXCEPTION 'Task is not in progress';
  END IF;

  SELECT COALESCE(amount, t.price) INTO agreed
  FROM bids WHERE id = t.selected_bid_id;
  IF agreed IS NULL THEN
    agreed := t.price;
  END IF;

  UPDATE tasks
  SET status = 'completed', completed_at = NOW()
  WHERE id = p_task_id;

  IF t.selected_doer_id IS NOT NULL THEN
    UPDATE profiles
    SET tasks_completed = COALESCE(tasks_completed, 0) + 1
    WHERE id = t.selected_doer_id;
  END IF;

  IF t.payment_method = 'escrow' AND t.selected_doer_id IS NOT NULL THEN
    UPDATE profiles
    SET wallet_held = GREATEST(0, COALESCE(wallet_held, 0) - agreed)
    WHERE id = t.poster_id;

    UPDATE profiles
    SET wallet_balance = COALESCE(wallet_balance, 0) + agreed
    WHERE id = t.selected_doer_id;

    INSERT INTO transactions (user_id, task_id, type, amount, description)
    VALUES
      (t.poster_id, p_task_id, 'released', agreed, 'Payment released for: ' || t.title),
      (t.selected_doer_id, p_task_id, 'received', agreed, 'Payment received for: ' || t.title);
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION complete_task(UUID) TO authenticated;
