-- What an agent token may do. Existing tokens keep both, which is what they could do before.
alter table agent_tokens add column if not exists scopes text[] not null default '{read,write}';
