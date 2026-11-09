-- CELL tenant API keys and the Database Webhook that synchronizes LiteLLM Virtual Keys.

create extension if not exists pgcrypto;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

create table if not exists public.cell_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  litellm_team_id text not null unique check (length(trim(litellm_team_id)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cell_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.cell_tenants(id) on delete restrict,
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  key_prefix text not null,
  key_last4 text not null check (length(key_last4) = 4),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoking', 'revoked')),
  litellm_key_id text,
  litellm_key_ciphertext text,
  litellm_key_nonce text,
  litellm_key_tag text,
  litellm_key_version integer,
  sync_version bigint not null default 1 check (sync_version > 0),
  sync_error text,
  sync_claim_token uuid,
  sync_claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  constraint cell_litellm_ciphertext_complete check (
    (litellm_key_ciphertext is null and litellm_key_nonce is null and litellm_key_tag is null and litellm_key_version is null)
    or
    (litellm_key_ciphertext is not null and litellm_key_nonce is not null and litellm_key_tag is not null and litellm_key_version is not null)
  )
);

create index if not exists cell_api_keys_reconcile_idx
  on public.cell_api_keys(status, updated_at)
  where status in ('pending', 'revoking');

alter table public.cell_tenants enable row level security;
alter table public.cell_api_keys enable row level security;
revoke all on public.cell_tenants from anon, authenticated;
revoke all on public.cell_api_keys from anon, authenticated;

create or replace function public.cell_claim_api_key_sync(
  p_id uuid,
  p_sync_version bigint,
  p_status text,
  p_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  update public.cell_api_keys
  set sync_claim_token = p_token,
      sync_claimed_at = now()
  where id = p_id
    and sync_version = p_sync_version
    and status = p_status
    and status in ('pending', 'revoking')
    and (sync_claimed_at is null or sync_claimed_at < now() - interval '2 minutes')
  returning id into claimed_id;
  return claimed_id is not null;
end;
$$;

revoke all on function public.cell_claim_api_key_sync(uuid, bigint, text, uuid) from public, anon, authenticated;
grant execute on function public.cell_claim_api_key_sync(uuid, bigint, text, uuid) to service_role;

create or replace function public.cell_dispatch_api_key_webhook()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  webhook_url text;
  webhook_secret text;
begin
  if new.status not in ('pending', 'revoking') then
    return new;
  end if;

  select decrypted_secret into strict webhook_url
  from vault.decrypted_secrets
  where name = 'cell_sync_webhook_url';

  select decrypted_secret into strict webhook_secret
  from vault.decrypted_secrets
  where name = 'cell_webhook_secret';

  perform net.http_post(
    url := webhook_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || webhook_secret
    ),
    body := jsonb_build_object(
      'type', tg_op,
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new),
      'old_record', case when tg_op = 'UPDATE' then to_jsonb(old) else null end
    ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists cell_api_key_webhook on public.cell_api_keys;
create trigger cell_api_key_webhook
after insert or update of status, sync_version on public.cell_api_keys
for each row
when (new.status in ('pending', 'revoking'))
execute function public.cell_dispatch_api_key_webhook();

-- Run once per Supabase project outside the migration, replacing both values:
-- select vault.create_secret('https://cell-auth.example/v1/webhooks/api-keys', 'cell_sync_webhook_url');
-- select vault.create_secret('a-separate-random-webhook-secret', 'cell_webhook_secret');
