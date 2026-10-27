import { createClient } from '@supabase/supabase-js';

// These will be set as environment variables in Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

// Server-side client (for API routes - has full access)
export function createServerClient() {
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Client-side config (for frontend - respects RLS)
export function getClientConfig() {
  return {
    url: supabaseUrl,
    anonKey: supabaseAnonKey
  };
}

// Helper: get authenticated user from request
export async function getUser(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;

  const supabase = createClient(supabaseUrl, supabaseAnonKey);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error) return null;
  return user;
}

// Helper: send JSON response
export function json(res, data, status = 200) {
  res.status(status).json(data);
}

// Helper: send error response
export function error(res, message, status = 400) {
  res.status(status).json({ error: message });
}
