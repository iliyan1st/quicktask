import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  const { data: { user } } = await authClient.auth.getUser(token);
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // GET /api/users/me - Get current user's full profile + stats
  if (req.method === 'GET') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    // Get user's posted tasks
    const { data: postedTasks } = await supabase
      .from('tasks')
      .select(`
        *,
        bids (id, amount, status, bidder:profiles!bidder_id (id, username, full_name, avatar_url, rating_avg, trust_level)),
        selected_doer:profiles!selected_doer_id (id, username, full_name, avatar_url, rating_avg, trust_level)
      `)
      .eq('poster_id', user.id)
      .order('created_at', { ascending: false });

    // Get tasks user bid on
    const { data: myBids } = await supabase
      .from('bids')
      .select(`
        *,
        task:tasks (
          *,
          poster:profiles!poster_id (id, username, full_name, avatar_url, rating_avg, trust_level)
        )
      `)
      .eq('bidder_id', user.id)
      .order('created_at', { ascending: false });

    // Get unread notification count
    const { count: unreadNotifications } = await supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('is_read', false);

    // Get unread message count
    const { data: convos } = await supabase
      .from('conversations')
      .select('id')
      .or(`poster_id.eq.${user.id},doer_id.eq.${user.id}`);

    let unreadMessages = 0;
    if (convos?.length) {
      const convoIds = convos.map(c => c.id);
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .in('conversation_id', convoIds)
        .neq('sender_id', user.id)
        .eq('is_read', false);
      unreadMessages = count || 0;
    }

    return res.status(200).json({
      profile,
      posted_tasks: postedTasks || [],
      my_bids: myBids || [],
      unread_notifications: unreadNotifications || 0,
      unread_messages: unreadMessages
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
