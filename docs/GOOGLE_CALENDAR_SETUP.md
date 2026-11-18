# Setting up two-way Google Calendar sync

Until this is done, More › Calendar shows **“Needs setting up”** next to Google Calendar, and
nothing talks to Google. The private calendar link (one-way) works without any of this.

**Booked with Joe: Friday 20 November 2026, 8pm (Guernsey).** About 20–30 minutes.

## Plan for Friday at a glance

| Part | What                                              | Who                                                         | Time   |
| ---- | ------------------------------------------------- | ----------------------------------------------------------- | ------ |
| A    | Steps 1–4 below: Google Cloud project and sign-in | Joe, signed in to his Google, on a computer (not the phone) | 15 min |
| B    | Step 5: give the app its three secrets            | Joe pastes them into a private form; never in chat or email | 5 min  |
| C    | Step 6: connect and try a move both ways          | Joe and the bot together                                    | 5 min  |

**Have ready:** a computer with Chrome/Edge/Safari, the Google account that should own the setup
(the LSE business account is a good choice), and a password manager or note to keep the client
secret in.

**Good to know:** the app isn’t online yet (see `DEPLOY.md`), so on Friday it’s connected to the
test copy of the app on the bot’s computer (address `http://127.0.0.1:5173`). That address only
works in the bot’s own browser, so Part C happens there: Joe opens the bot’s desktop and signs in
to Google himself (the bot never sees or types the password). When the app goes
online, one extra line is added in step 4.3 and the secrets go into the live app (step 5); nothing
else needs redoing.

What the app asks Google for, and nothing more:

- **See and change only calendars the app makes itself** (`calendar.app.created`). The app makes
  one calendar called **“LSE jobs”** in each person’s Google account and only touches that one.
  It can’t read the rest of anyone’s calendar.
- **Your email address** (`openid email`), so the app can show which Google account is connected.

Both are “non-sensitive” scopes, so Google doesn’t need to review or verify the app.

## 1. Make a Google Cloud project

1. Go to <https://console.cloud.google.com/> and sign in with the account that will own the setup.
2. Top bar › project picker › **New Project**. Name it e.g. `LSE Trade App`. Create it, then make
   sure it’s selected in the project picker.

## 2. Switch on the Google Calendar API

1. Menu › **APIs & Services › Library**.
2. Search for **Google Calendar API**, open it and click **Enable**.

## 3. Consent screen (what people see when they connect)

1. Menu › **APIs & Services › OAuth consent screen** (newer consoles call this **Google Auth
   Platform › Branding / Audience / Data access**).
2. **App name**: `LSE Trade App` (or the product’s name). **User support email**: your email.
   **Developer contact**: your email.
3. **Audience / User type**: **External**.
4. **Data access / Scopes** › Add or remove scopes. Tick:
   - `openid`
   - `.../auth/userinfo.email`
   - `https://www.googleapis.com/auth/calendar.app.created` (paste it in “Manually add scopes” if
     it isn’t in the list)
5. **Publish the app** (Audience › Publishing status › **Publish app** / “In production”).
   Important: while it’s left in **Testing**, Google cancels the connection after **7 days** and
   everyone has to connect again. Because the scopes are non-sensitive, publishing doesn’t need
   Google’s verification.

## 4. Make the OAuth client

1. Menu › **APIs & Services › Credentials** › **Create credentials › OAuth client ID**.
2. **Application type**: **Web application**. Name: `LSE Trade App web`.
3. **Authorised redirect URIs** › Add URI, exactly (no trailing slash):

   ```
   https://<your app address>/api/calendar-sync/google/callback
   ```

   On Friday (test copy), add just this one:

   ```
   http://127.0.0.1:5173/api/calendar-sync/google/callback
   ```

   When the app goes online, come back here and add the live one too:
   `https://<your app address>/api/calendar-sync/google/callback`, where `<your app address>` is
   `APP_ORIGIN` in `apps/api/wrangler.jsonc`.

4. Create. Copy the **Client ID** and **Client secret** (keep the secret private).

## 5. Give the app the three secrets

**On Friday:** the bot sends Joe a private form with three boxes (Client ID, Client secret, and a
key it makes for you). Paste them there, never into chat or email. They go into
`apps/api/.dev.vars` on the bot’s computer, which is never committed.

**When the app is online**, from `apps/api`:

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID       # paste the Client ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET   # paste the Client secret
openssl rand -base64 32                              # makes a fresh random key; copy it
pnpm exec wrangler secret put CALENDAR_TOKEN_KEY     # paste that key
```

`CALENDAR_TOKEN_KEY` locks (encrypts) each person’s Google sign-in before it’s stored in the
database, so a copy of the database alone is useless. Keep it somewhere safe (e.g. a password
manager). If it’s lost or changed, nothing breaks except that everyone has to press **Connect**
again.

For local development put the same three lines in `apps/api/.dev.vars` (never commit that file):

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
CALENDAR_TOKEN_KEY=...
```

Optional: `GOOGLE_REDIRECT_URI` overrides the redirect address if it can’t be
`<APP_ORIGIN>/api/calendar-sync/google/callback`.

Then deploy (`pnpm exec wrangler deploy`). The database changes it needs are migrations
`0026_google_calendar.sql` and `0027_calendar_activity.sql` (`pnpm db:migrate`).

## 6. Connect and check

1. In the app: **More › Calendar › Two-way sync with Google Calendar › Connect**.
2. Google asks you to choose an account and allow access. Tick the calendar box if it’s shown
   unticked.
3. You come back to the Calendar screen with “Google Calendar connected”. A calendar called
   **LSE jobs** appears in Google Calendar and fills with your booked jobs (no prices, just the job
   number, title, customer and place).
4. Each person connects their own Google account from their own login and gets their own bookings.
5. Quick check together: move a booked job in Google Calendar, press **Sync Now** in the app and
   see it move (and listed under **Changes from Google Calendar** with **Undo**). Then move it in
   the app and see Google follow.

## How it behaves day to day

- It syncs by itself every 15 minutes, and **Sync Now** does it straight away.
- Booking, moving or cancelling a job in the app updates Google.
- Moving or deleting a job in Google **updates the app straight away** (Joe, 18 Nov 2026). Each
  change is listed on the Calendar screen under **Changes from Google Calendar** with **Undo**,
  which puts the app and Google back. Undo works on the latest change while nothing else has
  changed that booking since.
- If the same booking was changed in both places between syncs, Google’s change wins and the list
  says so.
- Events you add yourself to the LSE jobs calendar are left alone.
- If someone removes the app’s access in their Google account (or deletes the LSE jobs calendar),
  the Calendar screen says so and shows **Connect Again**. Reconnecting makes a fresh LSE jobs
  calendar if the old one is gone.
- **Disconnect** stops syncing. The LSE jobs calendar stays in Google; delete it there if you
  don’t want it.

## If something goes wrong

| What you see                                      | Why / what to do                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| “Needs setting up”                                | One of the three secrets is missing. Check step 5 and redeploy.           |
| Google says `redirect_uri_mismatch`               | The redirect URI in step 4 doesn’t exactly match the app’s address.       |
| “Tick the calendar box…”                          | The calendar permission was unticked on Google’s page. Connect again.     |
| “That sign-in expired or wasn’t started here”     | Took longer than 10 minutes, or opened in another browser. Connect again. |
| Everyone has to reconnect after a week            | The consent screen is still in Testing. Publish it (step 3.5).            |
| “Google no longer allows access … Connect again.” | Access was removed in the Google account. Press Connect Again.            |
