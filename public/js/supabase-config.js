/**
 * Supabase Client Configuration
 */
const SUPABASE_URL = 'https://iukgnucrdaihpagertvr.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml1a2dudWNyZGFpaHBhZ2VydHZyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1NjM2ODIsImV4cCI6MjEwNDEzOTY4Mn0.QpHhLNlhzUInk3EN8Yay9uR6uet0E2QDZcx49g4amOA';

// Create Supabase client with local session persistence for Safari/PWA
const supabaseClient = (window.supabase && window.supabase.createClient) 
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: window.localStorage
      }
    }) 
  : null;

window.supabaseClient = supabaseClient;
