# CreatorHub MVP (GitHub Pages + Supabase)

This is a lightweight MVP for booking creatives in LA:

- Public Home Feed (no login required)
- Magic-link login
- After login: choose **Artist** or **Creator**
- **Artists**: create a project (service + tier) → pick a creator → request a date → message
- **Creators**: create up to **4 packages** (Bronze/Silver/Gold/Elite) and accept projects
- Credits wallet is **demo-only** (Stripe later)

---

## 1) Deploy to GitHub Pages

1. Create a repo (example: `creatorbook`)
2. Upload everything in this folder to the repo root
3. In GitHub: **Settings → Pages**
4. Source: `Deploy from branch` → `main` → `/ (root)`
5. Your site becomes:
   - `https://clawboi.github.io/creatorbook/`

---

## 2) Supabase: set Redirect URLs (fixes “magic link loop”)

In Supabase Dashboard:

- **Authentication → URL Configuration**
  - **Site URL**: `https://clawboi.github.io/creatorbook/`
  - **Redirect URLs**: add BOTH:
    - `https://clawboi.github.io/creatorbook/`
    - `https://clawboi.github.io/creatorbook/index.html`

Why: the magic link returns to your website. If the URL isn’t allowed, Supabase signs in but the browser can’t complete the session and it looks like you’re stuck sending links.

---

## 3) Supabase: create tables + RLS

In Supabase:

- **SQL Editor** → run the `schema.sql` file (included)

If you already ran a broken schema before:
- easiest: **create a fresh Supabase project**, then run schema.sql once.

---

## 4) Create `config.js`

In your repo root (same level as `index.html`), create a file named `config.js`.

Copy/paste and fill in values:

```js
window.CREATORHUB_CONFIG = {
  supabaseUrl: "https://YOUR_PROJECT_REF.supabase.co",
  supabaseAnonKey: "YOUR_SUPABASE_ANON_KEY",
};
```

Where to find these:

- Supabase: **Project Settings → API**
  - `Project URL` → `supabaseUrl`
  - `Publishable (anon) key` → `supabaseAnonKey`

✅ Do **NOT** put the `sb_secret_...` key in GitHub Pages.

---

## 5) Test the MVP

1. Open your GitHub Pages site
2. Browse Home Feed (works without account)
3. Click **Sign in**
4. Pick **Artist** or **Creator**, enter email, click magic link
5. After login you’ll see a big **Artist vs Creator** gate too (you can change later in Settings)

### Creator approval rule (important)
Creators can sign up anytime, but **won’t show publicly** until approved.

To approve a creator (admin action):
- Supabase → **Table Editor → profiles**
- Find the creator row
- Set:
  - `role = creator`
  - `approved = true`

Once approved, their packages appear in the public Home Feed.

---

## 6) Next upgrades (when you’re ready)

- Real availability calendar (Google Calendar sync or built-in availability table)
- Project chat UI (messages table is already in schema)
- Stripe: buy credits, escrow, automatic payouts
- Creator profile pages (portfolio embeds)
- Ranking algorithm + featured placements

