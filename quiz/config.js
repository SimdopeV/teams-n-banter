// Public settings for the quiz. The anon (or "publishable") key is safe to
// publish: row level security and the database functions decide what it can
// do. Never put the service_role (or "secret") key here or anywhere in the repo.
// Use a NEW Supabase project for Teams & Banter (not the Arc PH one).
window.QUIZ_CONFIG = {
  SUPABASE_URL: 'YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-KEY',
  GAME_CODE: 'TNB',
  PLAYER_URL: '' // e.g. 'https://simdopev.github.io/teams-n-banter/quiz/'. Empty = the folder the host page is served from.
};
