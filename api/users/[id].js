import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const { id } = req.query;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // GET /api/users/:id - Get user profile
  if (req.method === 'GET') {
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, username, full_name, avatar_url, bio, location, trust_level, email_verified, phone_verified, tasks_completed, tasks_posted, rating_avg, rating_count, is_premium, created_at')
      .eq('id', id)
      .single();

    if (error || !profile) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get recent ratings
    const { data: ratings } = await supabase
      .from('ratings')
      .select(`
        *,
        rater:profiles!rater_id (id, username, full_name, avatar_url),
        task:tasks (id, title)
      `)
      .eq('rated_id', id)
      .order('created_at', { ascending: false })
      .limit(10);

    return res.status(200).json({ profile, ratings: ratings || [] });
  }

  // PATCH /api/users/:id - Update own profile
  if (req.method === 'PATCH') {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user } } = await authClient.auth.getUser(token);
    if (!user || user.id !== id) {
      return res.status(403).json({ error: 'Can only update own profile' });
    }

    const allowedFields = ['full_name', 'username', 'bio', 'location', 'latitude', 'longitude', 'avatar_url', 'phone'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ profile: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
