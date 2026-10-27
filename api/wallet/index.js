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

  // GET /api/wallet - Get wallet balance and transactions
  if (req.method === 'GET') {
    const { data: profile } = await supabase
      .from('profiles')
      .select('wallet_balance, wallet_held, payment_mode')
      .eq('id', user.id)
      .single();

    const { data: transactions } = await supabase
      .from('transactions')
      .select(`
        *,
        task:tasks (id, title)
      `)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    return res.status(200).json({
      balance: {
        available: profile.wallet_balance || 0,
        held: profile.wallet_held || 0,
        total: (profile.wallet_balance || 0) + (profile.wallet_held || 0),
        payment_mode: profile.payment_mode
      },
      transactions: transactions || []
    });
  }

  // POST /api/wallet - Add funds (mock - in real app this would go through Stripe)
  if (req.method === 'POST') {
    const { action, amount } = req.body;

    if (action === 'add_funds') {
      if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('wallet_balance')
        .eq('id', user.id)
        .single();

      await supabase.from('profiles').update({
        wallet_balance: (profile.wallet_balance || 0) + amount
      }).eq('id', user.id);

      await supabase.from('transactions').insert({
        user_id: user.id,
        type: 'deposit',
        amount,
        description: 'Funds added to wallet',
        status: 'completed'
      });

      return res.status(200).json({
        message: 'Funds added',
        new_balance: (profile.wallet_balance || 0) + amount
      });
    }

    if (action === 'set_payment_mode') {
      const { mode } = req.body;
      if (!['cash', 'escrow'].includes(mode)) {
        return res.status(400).json({ error: 'Mode must be cash or escrow' });
      }

      await supabase.from('profiles').update({
        payment_mode: mode
      }).eq('id', user.id);

      return res.status(200).json({ message: `Payment mode set to ${mode}` });
    }

    return res.status(400).json({ error: 'Invalid action' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
