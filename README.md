# Relay Chat

A full-stack, real-time direct messaging app for a software engineering portfolio.

**Stack:** React + TypeScript + Vite · Express + Socket.IO · Supabase Auth + PostgreSQL · Render · GitHub.

## Features

- Sign up, email confirmation, sign in and sign out with Supabase Auth
- Automatic username profile creation through a Postgres trigger
- Start direct chats by username
- Persist messages in PostgreSQL
- Live Socket.IO delivery with server-side JWT validation and membership checks
- Responsive dark-themed chat interface
- Render Blueprint deployment configuration

## 1. Create Supabase project

1. Create a Supabase project at https://supabase.com/dashboard.
2. Open **SQL Editor**, paste the full contents of [supabase/schema.sql](supabase/schema.sql), and run it **once**.
3. In **Project Settings → API**, copy the Project URL, publishable/anon key, and service_role/secret key.
4. In **Authentication → URL Configuration**, set the Site URL to your eventual Render frontend URL. For local testing use http://localhost:5173.
5. In **Authentication → Providers → Email**, choose whether email confirmation is required. Both flows are supported.
6. Usernames must be lowercase letters, numbers or underscores, 3–24 characters. If a username is taken, the signup trigger assigns an available suffix after the account-repair migration is applied.

**Important:** The service role key must ONLY be set in the backend's Render environment. Never place it in `VITE_*` variables or commit it.

## 2. Deploy to Render

1. Open https://dashboard.render.com/ and choose **New → Blueprint**.
2. Connect this GitHub repository and select `render.yaml`.
3. Supply the requested environment variables.

**API service (`relay-api`)**

- `SUPABASE_URL` = Supabase project URL
- `SUPABASE_ANON_KEY` = Supabase publishable/anon key
- `SUPABASE_SERVICE_ROLE_KEY` = Supabase service role/secret key (backend only)
- `CLIENT_ORIGIN` = exact frontend URL, e.g. `https://relay-web.onrender.com` (no trailing slash)

**Static frontend (`relay-web`)**

- `VITE_SUPABASE_URL` = Supabase project URL
- `VITE_SUPABASE_ANON_KEY` = Supabase publishable/anon key
- `VITE_API_URL` = exact backend URL, e.g. `https://relay-api.onrender.com` (no trailing slash)

After Render assigns URLs, verify `CLIENT_ORIGIN` and `VITE_API_URL`, save and redeploy if necessary. Set the Supabase Auth Site URL to the frontend URL. Changes to Vite environment variables require rebuilding the static site.

## Relay 2.0 upgrade (existing deployments)

Deploy the latest commit to **both** Render services: `relay-api` and `relay-web`.
No new environment variables are needed. The API adds authenticated profile editing,
typing events, and message edit/delete endpoints. The web app adds account settings,
conversation/message search, typing indicators, and connection feedback.

In Supabase SQL Editor, run
[`supabase/migrations/20261113_relay_account_repair.sql`](supabase/migrations/20261113_relay_account_repair.sql)
to repair the signup trigger and backfill profiles for users created directly in
Supabase Auth. This script is intended for an existing Relay database; do not
rerun the entire `schema.sql` against a populated database.

After deployment, sign in with two users. Open the same conversation in two
browser sessions to test typing, message editing/deletion, and profile username
changes. Username changes appear in other sessions when connected.

## 3. Run locally (optional)

Requires Node.js 20+. Copy `api/.env.example` to `api/.env` and `web/.env.example` to `web/.env` and fill in the Supabase credentials.

Terminal 1:

```bash
cd api
npm install
npm run dev
```

Terminal 2:

```bash
cd web
npm install
npm run dev
```

Visit http://localhost:5173.

## Test

Create two accounts with different emails and usernames. Sign in as each user in separate browsers. Start a conversation by entering the other person's username. Send messages and check that both users see them.

## Security and known limitations

This is a portfolio MVP, not a production-hardened messenger. It does **not** provide end-to-end encryption. Add rate limiting, abuse controls, automated tests, message pagination, observability, transaction-safe direct conversation creation, and robust reconnection synchronization before scaling or publicly promoting it. Supabase RLS denies direct client access to conversation and message tables; the backend uses a secret service role client and enforces membership checks on every protected operation. Keep that key private.

Render's free instances may sleep when idle; WebSocket connections can disconnect and reconnect.
