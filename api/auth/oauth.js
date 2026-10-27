import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { provider } = req.body; // 'google' or 'facebook'

  if (!['google', 'facebook'].includes(provider)) {
    return res.status(400).json({ error: 'Provider must be google or facebook' });
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'}/auth/callback`
    }
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(200).json({ url: data.url });
}
