# FREITTY · GBP dashboard

Google Business Profile stats for all FREITTY locations, refreshed automatically every day.

- **Dashboard** (Ukrainian), served from `site/` on Vercel. It covers all 26 hubs in the two GBP accounts, and has six tabs:
  - **Огляд**: KPIs against the previous period, compared only across hubs that have data in both periods. Also weekly signals (7 days vs the 4-week average), monthly activity, calls by hub, Maps share vs engagement, and the all-hubs table.
  - **Хаб**: one hub in detail, including where views come from, search intent, terms and recent posts.
  - **Пошуковий попит**: intent mix per hub, buying searches below Google's 15 threshold, new terms, and every term.
  - **Публікації**: posts from the GBP API, with days since the last post, a weekly grid, buttons, duplicates, and rejected or scheduled posts.
  - **Прогноз**: eight models with a backtest, weighted by accuracy, for the network (hubs active more than a year) and for each hub.
  - **Дзвінки**: the live CallRail log.
- **Design**: `site/styles.css` holds the tokens: Geist font, named text styles on the Tailwind scale, spacing tokens, flat surfaces, and Phosphor icons. Charts are hand-built SVG in `site/charts.js`, using the validated categorical palette.
- **Search intent**: `site/intent.js`. Terms that are already labelled in the GBP tracker use `site/intent_labels.json`. New terms are classified by rules, which agree with the tracker on 88% of terms and 90% of chart groups.
- **Data**: `site/data.json` is the single source of truth in git (about 2 MB). It holds daily metrics since Nov 2024, monthly keywords, and the current posts of every profile.
- **Refresh**: GitHub Actions (`.github/workflows/daily-pull.yml`) runs every day at 06:15 UTC:
  1. `data_io.py import` rebuilds `gbp.db` from `data.json`.
  2. `pull_gbp.py --days 14` re-pulls the last 14 days of metrics and keywords, plus every profile's posts, then upserts them.
  3. `data_io.py export` writes `data.json` back.
  4. The workflow commits the change, and Vercel redeploys automatically.
- **Trailing zeros**: Google returns zeros for days it hasn't reported yet, usually the last 2–3 days. The dashboard ends the data on the last day with any views, so those zeros never read as a drop.

## One-time setup

1. **GitHub secret `GBP_TOKEN_JSON`**: go to repo → Settings → Secrets and variables → Actions → New repository secret. Paste the full contents of `token.json` (from the local GBP folder). This is the OAuth token of the Google account that manages the GBP locations.
2. **Vercel**: Add New → Project → import this repo. Use Framework *Other* and keep everything else at its defaults. `vercel.json` already serves `site/`.
3. **First run**: open Actions → *Daily GBP pull* → Run workflow and keep `days` = 14.

Data commits are authored as `vlad-freitty`'s noreply address, because Vercel Hobby only auto-deploys private-repo commits made by the owner. To use someone else, set the repo variables `COMMIT_AUTHOR_NAME` and `COMMIT_AUTHOR_EMAIL`.

## Sign-in and the Calls tab

The whole site (dashboard, `data.json`, calls) is behind **Microsoft sign-in**: only accounts in the FREITTY Microsoft tenant get in (`middleware.js`). The **Calls** tab reads the call log **live from CallRail** through `/api/calls`. Customer phone numbers are never written to git.

- Channels (Google Ads, Google Maps Ads, Google Maps organic, Google organic site) come from the rules in `CHANNEL_RULES` in `lib/callrail.js`. The *Sources in CallRail* table at the bottom of the tab shows how each tracking number was counted.
- CallRail keeps calls for 25 months, so that's the longest period you can pick.

### One-time setup

1. **Microsoft Entra app** (portal.azure.com → Microsoft Entra ID → App registrations → New registration). This needs an admin of the FREITTY Microsoft 365 account.
   - Name: `FREITTY dashboard`. Account type: *this organizational directory only*.
   - Redirect URI: platform **Web**, `https://<vercel-domain>/api/auth/callback`.
   - Authentication → tick **ID tokens**. No client secret is needed.
   - Copy the **Application (client) ID** and the **Directory (tenant) ID**.
2. **CallRail API key**: CallRail → Settings → Integrations → API Keys → create a key. Use a user that can see every company.
3. **Vercel** → Project → Settings → Environment Variables (Production):

   | Name | Value |
   |---|---|
   | `AUTH_TENANT_ID` | Directory (tenant) ID |
   | `AUTH_CLIENT_ID` | Application (client) ID |
   | `SESSION_SECRET` | random string, 32+ characters (`node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`) |
   | `CALLRAIL_API_KEY` | CallRail API key |
   | `CALLRAIL_ACCOUNT_ID` | optional: the first account on the key is used by default |
   | `ALLOWED_EMAILS` | optional: comma-separated list. If set, only these people can open the dashboard. |
   | `SESSION_HOURS` | optional: sign-in lasts 12 hours by default (same as the CS Wiki) |

   Set these **before** pushing. Until the three `AUTH_*`/`SESSION_SECRET` variables exist, the site shows "Вхід ще не налаштовано" instead of the dashboard.
4. **Who can sign in** (same as the CS Wiki): Entra → Enterprise applications → this app → Properties → *Assignment required* = **Yes**, then add people or groups under *Users and groups*. Anyone not assigned gets "Доступ до дашборда не надано". Without this, everyone in the FREITTY tenant can sign in (or only `ALLOWED_EMAILS`, if set).
5. To sign everyone out immediately, change `SESSION_SECRET` and redeploy.

Signed-out visitors first see the dashboard's own sign-in page with a "Увійти через Microsoft" button. Microsoft then always shows the account picker (`prompt=select_account`), as in the CS Wiki.

### Local preview with fake data

`npm install`, then `npm test` runs the offline tests. `npm run dev` starts http://localhost:8765 with **fake** calls and a fake sign-in. It never calls CallRail or Microsoft.

## Day to day

Nothing to do. Open the Vercel URL.

- If the header warns that the data is old, check GitHub → Actions. GitHub also emails the repo owner when a run fails.
- **Token revoked or expired** (the run log says `GBP_TOKEN_JSON refresh failed`): fix it locally:
  1. Put `credentials.json` next to `pull_gbp.py`.
  2. Run `python pull_gbp.py --auth`.
  3. Paste the new `token.json` into the secret.
- **New location**:
  1. Add it to `locations.yaml` with its name, `location_id`, `account_id` and `address`. `python pull_gbp.py --list-locations` prints the IDs.
  2. Trigger the workflow manually with `days` = 540 and `locations` = its name, to backfill only that hub.
- **Thresholds for the *Needs attention* tab**: edit `SIG` at the top of the signals section in `site/index.html`. The defaults are: a drop of 30% or more is red, growth of 50% or more is green, and locations with a small baseline are ignored.

## Local run (optional)

```
pip install -r requirements.txt
python data_io.py import
python pull_gbp.py            # needs credentials.json + token.json locally
python data_io.py export
python -m http.server 8765 --directory site
```

`credentials.json`, `token.json`, `gbp.db` and CSVs are git-ignored. Never commit them.
