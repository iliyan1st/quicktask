import { createClient } from '@supabase/supabase-js';

// This endpoint should be called by a cron job (Vercel Cron or external)
// It transitions tasks from 'open' to 'selecting' when bidding ends,
// and from 'selecting' to 'expired' when selection time runs out.

export default async function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const headerSecret = req.headers['x-cron-secret'];
  const bearerOk = Boolean(expected) && req.headers.authorization === `Bearer ${expected}`;
  if (!expected || (headerSecret !== expected && !bearerOk)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const now = new Date().toISOString();
  let updated = { to_selecting: 0, to_expired: 0, refunded: 0 };

  // 1. Move tasks from 'open' to 'selecting' where bidding has ended
  const { data: endedTasks } = await supabase
    .from('tasks')
    .select('id, selection_duration_hours, bid_count')
    .eq('status', 'open')
    .lt('bidding_ends_at', now);

  if (endedTasks?.length) {
    for (const task of endedTasks) {
      if (task.bid_count > 0) {
        // Has bids - move to selecting
        const selectionEndsAt = new Date(
          Date.now() + task.selection_duration_hours * 60 * 60 * 1000
        ).toISOString();

        await supabase.from('tasks').update({
          status: 'selecting',
          selection_ends_at: selectionEndsAt
        }).eq('id', task.id);

        updated.to_selecting++;
      } else {
        // No bids - expire the task
        await supabase.from('tasks').update({
          status: 'expired'
        }).eq('id', task.id);

        // Refund escrow if applicable
        await refundEscrow(supabase, task.id);
        updated.to_expired++;
      }
    }
  }

  // 2. Expire tasks in 'selecting' where selection time has run out
  const { data: expiredSelections } = await supabase
    .from('tasks')
    .select('id')
    .eq('status', 'selecting')
    .lt('selection_ends_at', now);

  if (expiredSelections?.length) {
    for (const task of expiredSelections) {
      await supabase.from('tasks').update({
        status: 'expired'
      }).eq('id', task.id);

      // Reject all bids
      await supabase.from('bids').update({ status: 'rejected' })
        .eq('task_id', task.id).eq('status', 'pending');

      // Refund escrow
      await refundEscrow(supabase, task.id);
      updated.to_expired++;
      updated.refunded++;
    }
  }

  return res.status(200).json({
    message: 'Task statuses updated',
    ...updated,
    timestamp: now
  });
}

async function refundEscrow(supabase, taskId) {
  const { data: task } = await supabase
    .from('tasks')
    .select('poster_id, price, payment_method, title')
    .eq('id', taskId)
    .single();

  if (task?.payment_method === 'escrow') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('wallet_balance, wallet_held')
      .eq('id', task.poster_id)
      .single();

    await supabase.from('profiles').update({
      wallet_balance: (profile.wallet_balance || 0) + task.price,
      wallet_held: Math.max(0, (profile.wallet_held || 0) - task.price)
    }).eq('id', task.poster_id);

    await supabase.from('transactions').insert({
      user_id: task.poster_id,
      task_id: taskId,
      type: 'refund',
      amount: task.price,
      description: `Refund for expired task: ${task.title}`
    });
  }
}
