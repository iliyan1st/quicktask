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

  // GET /api/messages - List user's conversations
  if (req.method === 'GET') {
    const { conversation_id } = req.query;

    // If conversation_id provided, return messages for that conversation
    if (conversation_id) {
      // Verify user is part of conversation
      const { data: conv } = await supabase
        .from('conversations')
        .select('*')
        .eq('id', conversation_id)
        .or(`poster_id.eq.${user.id},doer_id.eq.${user.id}`)
        .single();

      if (!conv) {
        return res.status(404).json({ error: 'Conversation not found' });
      }

      if (!conv.is_unlocked) {
        return res.status(403).json({
          error: 'Chat will be available once a bidder is selected',
          locked: true
        });
      }

      const { data: messages, error } = await supabase
        .from('messages')
        .select(`
          *,
          sender:profiles!sender_id (id, username, full_name, avatar_url)
        `)
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: true });

      if (error) {
        return res.status(500).json({ error: error.message });
      }

      // Mark messages as read
      await supabase
        .from('messages')
        .update({ is_read: true })
        .eq('conversation_id', conversation_id)
        .neq('sender_id', user.id)
        .eq('is_read', false);

      return res.status(200).json({ messages, conversation: conv });
    }

    // Otherwise, list all conversations
    const { data: conversations, error } = await supabase
      .from('conversations')
      .select(`
        *,
        task:tasks (id, title, price, status),
        poster:profiles!poster_id (id, username, full_name, avatar_url, trust_level),
        doer:profiles!doer_id (id, username, full_name, avatar_url, trust_level)
      `)
      .or(`poster_id.eq.${user.id},doer_id.eq.${user.id}`)
      .order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Get unread count for each conversation
    for (const conv of conversations) {
      const { count } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_id', conv.id)
        .neq('sender_id', user.id)
        .eq('is_read', false);

      conv.unread_count = count || 0;
    }

    return res.status(200).json({ conversations });
  }

  // POST /api/messages - Send a message
  if (req.method === 'POST') {
    const { conversation_id, content } = req.body;

    if (!conversation_id || !content) {
      return res.status(400).json({ error: 'conversation_id and content are required' });
    }

    // Verify user is part of conversation and it's unlocked
    const { data: conv } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversation_id)
      .or(`poster_id.eq.${user.id},doer_id.eq.${user.id}`)
      .single();

    if (!conv) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    if (!conv.is_unlocked) {
      return res.status(403).json({
        error: 'Chat will be available once a bidder is selected',
        locked: true
      });
    }

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_id: user.id,
        content
      })
      .select(`
        *,
        sender:profiles!sender_id (id, username, full_name, avatar_url)
      `)
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    // Update conversation last_message_at
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('id', conversation_id);

    // Notify the other user
    const recipientId = conv.poster_id === user.id ? conv.doer_id : conv.poster_id;
    const { data: sender } = await supabase
      .from('profiles').select('full_name').eq('id', user.id).single();

    await supabase.from('notifications').insert({
      user_id: recipientId,
      type: 'new_message',
      title: `New message from ${sender.full_name}`,
      body: content.substring(0, 100),
      data: { conversation_id }
    });

    return res.status(201).json({ message });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
