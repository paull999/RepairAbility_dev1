# RepairAbility on Supabase

This folder is the deployable version of RepairAbility. Data lives in a Supabase
Postgres database, people sign in with Supabase Auth, and the access rules are enforced
by the database itself (not just the screen).

| File | What it is |
|---|---|
| `index.html` | The whole app (static, no build step) |
| `config.js` | Your Supabase URL and anon key (you edit this) |
| `schema.sql` | Database table, sign-up rules and row-level security (you run this once) |
| `manifest.webmanifest`, `*.png` | Home-screen icons (install as an app on phones) |

## 1. Create the Supabase project (5 minutes)

1. Sign up at supabase.com and click **New project**. Choose the region closest to your users
   (e.g. London). Save the database password somewhere safe.
2. Open **SQL Editor -> New query**, paste all of `schema.sql`, click **Run**. You should see "Success".
3. Open **Authentication -> Sign In / Providers -> Email** and check:
   - **Confirm email: ON** (keep it on. It stops someone claiming an invited email address).
   - **Minimum password length: 10**.
4. Open **Authentication -> URL Configuration** and set **Site URL** to the address the app will
   be hosted at (e.g. `https://repairability.netlify.app`). Add the same address to **Redirect URLs**.
   Reset-password and confirmation emails link back to it.
5. Open **Project Settings -> API** and copy the **Project URL** and the **anon public** key.

## 2. Configure the app

Edit `config.js`:

```js
window.RA_CONFIG = {
  url: 'https://abcdefgh.supabase.co',
  anonKey: 'eyJhbGciOi...'
};
```

Use the **anon** key only. Never put the `service_role` key in this file.

## 3. Host the folder

Any static host works. The simplest options (all have free tiers):

- **Netlify**: drag the whole `supabase` folder onto app.netlify.com/drop.
- **Cloudflare Pages**: Create project -> Direct Upload -> upload the folder.
- **Vercel**: `npx vercel` from inside the folder.

You get an `https://` address. Put that address into Supabase's Site URL (step 1.4) if you have not already.

## 4. First sign-in

1. Open the site, click **Create account**, and enter your name, email and a password.
   **The very first account created becomes the system administrator.**
2. Click the confirmation link in the email, then sign in.
3. In the app, add people under **People** (set their email, role, type and organisation).
4. Each person opens the site, clicks **Create account** using the email you entered, confirms it,
   and signs in. Anyone whose email has not been added, or whose status is Inactive, is refused.
5. Forgot password: **Forgot password?** on the sign-in screen, or an administrator can press
   **Send reset email** next to a person in the People list.

## What the database enforces

- **System administrators**: everything.
- **Service agents**: can only see jobs assigned to them, can only update those jobs, and can
  never change the locked fields (title, job type, address, customer details, price, priority,
  duration, booking window, servicer, assigned agent, organisation). They cannot create or delete jobs.
- **Other people**: can see and create/edit jobs, but cannot delete a job or change a job's
  organisation, and cannot change people, organisations or setup data.
- Signed-out visitors see nothing at all.

These rules were tested against a real PostgreSQL 16 instance. The test script is not shipped; the
policies are in `schema.sql` if you want to review them.

## Things to know

- **Your existing data is not copied across.** This is a fresh database. (The previous version
  stored data inside Claude; use it as before, or re-enter standing data in the new one.)
- **Photos and documents** are stored in the database in chunks, as before. This is fine for
  modest use; the free Supabase database is 500 MB. If you expect a lot of photos, the next step
  is moving them to Supabase Storage.
- **Free-tier projects pause** after a week of no activity. Upgrade to Pro (about $25/month) for a
  business-critical system, which also gives daily backups.
- **Email sending**: Supabase's built-in email is rate-limited (a few messages an hour). For real
  use, add your own SMTP provider under Authentication -> SMTP Settings (Resend, Postmark, SendGrid...).
- Signing out, or 30 minutes of inactivity, clears the session and reloads the page.
