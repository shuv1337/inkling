-- Sign in with ChatGPT credentials. Tokens are stored as AES-GCM ciphertext.
-- This is not agent_tokens: those hashes let an MCP agent in, and never hold an OAuth token.
create table if not exists openai_auth (
  user_id text primary key,
  client_id text not null,
  host_id text not null,
  issuer text not null default 'https://auth.openai.com',
  subject text not null,
  email text,
  access_token_enc text,
  refresh_token_enc text,
  id_token_enc text,
  scopes text[] not null default '{}',
  expires_at timestamptz,
  earliest_refresh_at timestamptz,
  refreshed_at timestamptz,
  updated_at timestamptz not null default now()
);
