import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // GET /api/tasks - List tasks with filters
  if (req.method === 'GET') {
    const {
      category,
      sort = 'newest',
      search,
      status = 'open',
      lat,
      lng,
      page = 1,
      limit = 20
    } = req.query;

    let query = supabase
      .from('tasks')
      .select(`
        *,
        poster:profiles!poster_id (id, username, full_name, avatar_url, rating_avg, rating_count, trust_level)
      `)
      .eq('status', status)
      .range((page - 1) * limit, page * limit - 1);

    // Category filter
    if (category && category !== 'all') {
      query = query.eq('category', category);
    }

    // Search
    if (search) {
      const safe = String(search).replace(/[%_,.()"'\\]/g, ' ').trim();
      if (safe) {
        query = query.or(`title.ilike.%${safe}%,description.ilike.%${safe}%`);
      }
    }

    // Sorting
    switch (sort) {
      case 'newest':
        query = query.order('created_at', { ascending: false });
        break;
      case 'price_low':
        query = query.order('price', { ascending: true });
        break;
      case 'price_high':
        query = query.order('price', { ascending: false });
        break;
      case 'ending_soon':
        query = query.order('bidding_ends_at', { ascending: true });
        break;
      default:
        query = query.order('created_at', { ascending: false });
    }

    const { data, error, count } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // If lat/lng provided, calculate distances and sort
    if (lat && lng && sort === 'nearest') {
      const tasksWithDistance = data.map(task => ({
        ...task,
        distance: task.latitude && task.longitude
          ? getDistance(parseFloat(lat), parseFloat(lng), task.latitude, task.longitude)
          : null
      }));
      tasksWithDistance.sort((a, b) => (a.distance || 999) - (b.distance || 999));
      return res.status(200).json({ tasks: tasksWithDistance, count });
    }

    return res.status(200).json({ tasks: data, count });
  }

  // POST /api/tasks - Create a new task
  if (req.method === 'POST') {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: { user }, error: authError } = await authClient.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const {
      title,
      description,
      category,
      price,
      bidding_type,
      payment_method = 'cash',
      location,
      latitude,
      longitude,
      bidding_duration_hours = 24,
      selection_duration_hours = 3,
      photos = []
    } = req.body;

    const priceNum = Number(price);
    if (!title || !description || !category || !bidding_type || !Number.isFinite(priceNum) || priceNum <= 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const bidding_ends_at = new Date(Date.now() + bidding_duration_hours * 60 * 60 * 1000).toISOString();

    let escrowProfile = null;
    // If escrow payment, check wallet balance and hold funds
    if (payment_method === 'escrow') {
      const { data: profile } = await supabase
        .from('profiles')
        .select('wallet_balance, wallet_held')
        .eq('id', user.id)
        .single();

      if (!profile || Number(profile.wallet_balance) < priceNum) {
        return res.status(400).json({ error: 'Insufficient wallet balance for escrow' });
      }

      escrowProfile = profile;
      const { error: holdError } = await supabase.from('profiles').update({
        wallet_balance: Number(profile.wallet_balance) - priceNum,
        wallet_held: Number(profile.wallet_held || 0) + priceNum
      }).eq('id', user.id);

      if (holdError) {
        return res.status(500).json({ error: holdError.message });
      }

      await supabase.from('transactions').insert({
        user_id: user.id,
        type: 'held',
        amount: priceNum,
        description: `Held for task: ${title}`,
        status: 'completed'
      });
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        poster_id: user.id,
        title,
        description,
        category,
        price: priceNum,
        bidding_type,
        payment_method,
        location,
        latitude,
        longitude,
        bidding_duration_hours,
        selection_duration_hours,
        bidding_ends_at,
        photos
      })
      .select()
      .single();

    if (error) {
      if (escrowProfile) {
        await supabase.from('profiles').update({
          wallet_balance: escrowProfile.wallet_balance,
          wallet_held: escrowProfile.wallet_held || 0
        }).eq('id', user.id);
        await supabase.from('transactions').delete()
          .eq('user_id', user.id)
          .eq('type', 'held')
          .eq('description', `Held for task: ${title}`)
          .is('task_id', null);
      }
      return res.status(500).json({ error: error.message });
    }

    // Update escrow transaction with task_id
    if (payment_method === 'escrow') {
      await supabase.from('transactions')
        .update({ task_id: data.id })
        .eq('user_id', user.id)
        .eq('type', 'held')
        .eq('description', `Held for task: ${title}`)
        .is('task_id', null);
    }

    // Update poster's task count
    await supabase.rpc('increment_tasks_posted', { user_id: user.id });

    return res.status(201).json({ task: data });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Haversine distance in km
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
