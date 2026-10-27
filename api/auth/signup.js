import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { email, password, full_name, username } = req.body;

  if (!email || !password || !full_name || !username) {
    return res.status(400).json({ error: 'Email, password, full name, and username are required' });
  }

  // Sign up with Supabase Auth
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: {
        full_name,
        username
      }
    }
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.status(201).json({
    user: data.user,
    session: data.session,
    message: 'Check your email for verification link'
  });
}
