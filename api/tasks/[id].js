import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { id } = req.query;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // GET /api/tasks/:id - Get task detail with bids
  if (req.method === 'GET') {
    const { data: task, error } = await supabase
      .from('tasks')
      .select(`
        *,
        poster:profiles!poster_id (id, username, full_name, avatar_url, rating_avg, rating_count, trust_level),
        selected_doer:profiles!selected_doer_id (id, username, full_name, avatar_url, rating_avg, trust_level),
        bids (
          id, amount, message, status, created_at,
          bidder:profiles!bidder_id (id, username, full_name, avatar_url, rating_avg, rating_count, trust_level)
        )
      `)
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Task not found' });
    }

    return res.status(200).json({ task });
  }

  // PATCH /api/tasks/:id - Update task (select bid, complete, cancel)
  if (req.method === 'PATCH') {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user } } = await authClient.auth.getUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { action, bid_id, rating, rating_comment } = req.body;

    // Get the task
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', id)
      .single();

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // SELECT A BID
    if (action === 'select_bid') {
      if (task.poster_id !== user.id) {
        return res.status(403).json({ error: 'Only the poster can select a bid' });
      }
      if (!['open', 'selecting'].includes(task.status)) {
        return res.status(400).json({ error: 'Task is not in a selectable state' });
      }

      // Get the bid
      const { data: bid } = await supabase
        .from('bids')
        .select('*, bidder:profiles!bidder_id(*)')
        .eq('id', bid_id)
        .single();

      if (!bid || bid.task_id !== id || bid.status !== 'pending') {
        return res.status(404).json({ error: 'Bid not found' });
      }

      // Update task
      await supabase.from('tasks').update({
        status: 'in_progress',
        selected_bid_id: bid_id,
        selected_doer_id: bid.bidder_id
      }).eq('id', id);

      // Update bid statuses
      await supabase.from('bids').update({ status: 'selected' }).eq('id', bid_id);
      await supabase.from('bids').update({ status: 'rejected' })
        .eq('task_id', id).neq('id', bid_id);

      // Create and unlock conversation
      const agreedPrice = bid.amount || task.price;
      await supabase.from('conversations').upsert({
        task_id: id,
        poster_id: task.poster_id,
        doer_id: bid.bidder_id,
        is_unlocked: true,
        agreed_price: agreedPrice
      }, { onConflict: 'task_id,poster_id,doer_id' });

      // Send notifications
      await supabase.from('notifications').insert([
        {
          user_id: bid.bidder_id,
          type: 'bid_selected',
          title: 'Your bid was selected!',
          body: `You were selected for "${task.title}"`,
          data: { task_id: id }
        }
      ]);

      return res.status(200).json({ message: 'Bid selected', task_id: id });
    }

    // MARK AS COMPLETE
    if (action === 'complete') {
      if (task.poster_id !== user.id) {
        return res.status(403).json({ error: 'Only the poster can mark as complete' });
      }
      if (task.status !== 'in_progress') {
        return res.status(400).json({ error: 'Task is not in progress' });
      }

      await supabase.from('tasks').update({
        status: 'completed',
        completed_at: new Date().toISOString()
      }).eq('id', id);

      let agreedPrice = Number(task.price);
      if (task.selected_bid_id) {
        const { data: selectedBid } = await supabase
          .from('bids').select('amount').eq('id', task.selected_bid_id).single();
        if (selectedBid?.amount != null) agreedPrice = Number(selectedBid.amount);
      }

      // If escrow, release funds to doer
      if (task.payment_method === 'escrow') {

        // Release from poster's held
        const { data: posterProfile } = await supabase
          .from('profiles').select('wallet_held').eq('id', task.poster_id).single();

        await supabase.from('profiles').update({
          wallet_held: Math.max(0, Number(posterProfile?.wallet_held || 0) - agreedPrice)
        }).eq('id', task.poster_id);

        // Add to doer's balance
        const { data: doerProfile } = await supabase
          .from('profiles').select('wallet_balance, tasks_completed').eq('id', task.selected_doer_id).single();

        if (task.selected_doer_id && doerProfile) {
          await supabase.from('profiles').update({
            wallet_balance: Number(doerProfile.wallet_balance || 0) + agreedPrice,
            tasks_completed: (doerProfile.tasks_completed || 0) + 1
          }).eq('id', task.selected_doer_id);
        }

        // Record transactions
        await supabase.from('transactions').insert([
          {
            user_id: task.poster_id,
            task_id: id,
            type: 'released',
            amount: agreedPrice,
            description: `Payment released for: ${task.title}`
          },
          {
            user_id: task.selected_doer_id,
            task_id: id,
            type: 'received',
            amount: agreedPrice,
            description: `Payment received for: ${task.title}`
          }
        ]);
      } else if (task.selected_doer_id) {
        const { data: doerProfile } = await supabase
          .from('profiles').select('tasks_completed').eq('id', task.selected_doer_id).single();
        await supabase.from('profiles').update({
          tasks_completed: (doerProfile?.tasks_completed || 0) + 1
        }).eq('id', task.selected_doer_id);
      }

      // Add rating if provided
      if (rating) {
        await supabase.from('ratings').insert({
          task_id: id,
          rater_id: user.id,
          rated_id: task.selected_doer_id,
          score: rating,
          comment: rating_comment
        });
      }

      // Notify doer
      await supabase.from('notifications').insert({
        user_id: task.selected_doer_id,
        type: 'task_completed',
        title: 'Task marked as complete!',
        body: `"${task.title}" has been completed${task.payment_method === 'escrow' ? '. Payment has been released to your wallet.' : '.'}`,
        data: { task_id: id }
      });

      return res.status(200).json({ message: 'Task completed' });
    }

    // CANCEL TASK
    if (action === 'cancel') {
      if (task.poster_id !== user.id) {
        return res.status(403).json({ error: 'Only the poster can cancel' });
      }
      if (!['open', 'selecting'].includes(task.status)) {
        return res.status(400).json({ error: 'Cannot cancel task in current state' });
      }

      await supabase.from('tasks').update({ status: 'cancelled' }).eq('id', id);

      // Refund escrow if applicable
      if (task.payment_method === 'escrow') {
        const { data: profile } = await supabase
          .from('profiles').select('wallet_balance, wallet_held').eq('id', task.poster_id).single();

        await supabase.from('profiles').update({
          wallet_balance: (profile.wallet_balance || 0) + task.price,
          wallet_held: Math.max(0, (profile.wallet_held || 0) - task.price)
        }).eq('id', task.poster_id);

        await supabase.from('transactions').insert({
          user_id: task.poster_id,
          task_id: id,
          type: 'refund',
          amount: task.price,
          description: `Refund for cancelled task: ${task.title}`
        });
      }

      return res.status(200).json({ message: 'Task cancelled' });
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
