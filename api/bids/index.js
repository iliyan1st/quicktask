import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // POST /api/bids - Place a bid
  if (req.method === 'POST') {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user } } = await authClient.auth.getUser(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const { task_id, amount, message } = req.body;

    if (!task_id) {
      return res.status(400).json({ error: 'task_id is required' });
    }

    // Get the task
    const { data: task } = await supabase
      .from('tasks')
      .select('*')
      .eq('id', task_id)
      .single();

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Can't bid on own task
    if (task.poster_id === user.id) {
      return res.status(400).json({ error: 'Cannot bid on your own task' });
    }

    // Check task is open
    if (task.status !== 'open') {
      return res.status(400).json({ error: 'Task is not accepting bids' });
    }

    // Check bidding hasn't ended
    if (new Date(task.bidding_ends_at) < new Date()) {
      return res.status(400).json({ error: 'Bidding has ended' });
    }

    // For price bidding, amount is required
    if (task.bidding_type === 'price' && !(Number(amount) > 0)) {
      return res.status(400).json({ error: 'Amount is required for price bidding tasks' });
    }

    // Check for existing bid
    const { data: existingBid } = await supabase
      .from('bids')
      .select('id')
      .eq('task_id', task_id)
      .eq('bidder_id', user.id)
      .single();

    if (existingBid) {
      return res.status(400).json({ error: 'You already placed a bid on this task' });
    }

    const { data: bid, error } = await supabase
      .from('bids')
      .insert({
        task_id,
        bidder_id: user.id,
        amount: task.bidding_type === 'fixed' ? task.price : amount,
        message
      })
      .select(`
        *,
        bidder:profiles!bidder_id (id, username, full_name, avatar_url, rating_avg, trust_level)
      `)
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Notify task poster
    const { data: bidder } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', user.id)
      .single();

    await supabase.from('notifications').insert({
      user_id: task.poster_id,
      type: 'new_bid',
      title: 'New bid on your task',
      body: `${bidder?.full_name || 'Someone'} placed a bid on "${task.title}"`,
      data: { task_id, bid_id: bid.id }
    });

    return res.status(201).json({ bid });
  }

  // GET /api/bids?task_id=xxx - Get bids for a task
  if (req.method === 'GET') {
    const { task_id } = req.query;
    if (!task_id) {
      return res.status(400).json({ error: 'task_id is required' });
    }

    const { data: bids, error } = await supabase
      .from('bids')
      .select(`
        *,
        bidder:profiles!bidder_id (id, username, full_name, avatar_url, rating_avg, rating_count, trust_level)
      `)
      .eq('task_id', task_id)
      .order('created_at', { ascending: true });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ bids });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
