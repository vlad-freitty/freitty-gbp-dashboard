# FREITTY · GBP dashboard

Google Business Profile stats for all FREITTY locations, refreshed automatically every day.

- **Dashboard**: `site/index.html` on Vercel. It has three tabs: *Needs attention* (week-over-week drops and growth, zero-impression listings, new search keywords), *Performance* (heat tables by period × location), and *Keywords*.
- **Data**: `site/data.json` is the single source of truth in git (about 1 MB, the full history since Nov 2024).
- **Refresh**: GitHub Actions (`.github/workflows/daily-pull.yml`) runs every day at 06:15 UTC:
  1. `data_io.py import` rebuilds `gbp.db` from `data.json`.
  2. `pull_gbp.py --days 14` re-pulls the last 14 days from the GBP API and upserts them.
  3. `data_io.py export` writes `data.json` back.
  4. The workflow commits the change, and Vercel redeploys automatically.

## One-time setup

1. **GitHub secret `GBP_TOKEN_JSON`**: go to repo → Settings → Secrets and variables → Actions → New repository secret. Paste the full contents of `token.json` (from the local GBP folder). This is the OAuth token of the Google account that manages the GBP locations.
2. **Vercel**: Add New → Project → import this repo. Use Framework *Other* and keep everything else at its defaults. `vercel.json` already serves `site/`.
3. **First run**: open Actions → *Daily GBP pull* → Run workflow and keep `days` = 14.

Data commits are authored as `vlad-freitty`'s noreply address, because Vercel Hobby only auto-deploys private-repo commits made by the owner. To use someone else, set the repo variables `COMMIT_AUTHOR_NAME` and `COMMIT_AUTHOR_EMAIL`.

## Day to day

Nothing to do. Open the Vercel URL.

- If the header warns that the data is old, check GitHub → Actions. GitHub also emails the repo owner when a run fails.
- **Token revoked or expired** (the run log says `GBP_TOKEN_JSON refresh failed`): fix it locally:
  1. Put `credentials.json` next to `pull_gbp.py`.
  2. Run `python pull_gbp.py --auth`.
  3. Paste the new `token.json` into the secret.
- **New location**: add it to `locations.yaml`, then trigger the workflow manually with `days` = 540 to backfill it.
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
