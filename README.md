# Hacker News Daily Digest

A daily email digest of Hacker News, arranged by category.

Every morning it reads all six Hacker News feeds — top, best, new,
ask, show, and jobs — and emails one digest with a section for each:
**Top Stories, Best Stories, New Stories, Ask HN, Show HN, Jobs.**
Each story carries its title, link, points, comment count, author, and
a discussion link. A story appears once, in the first section that
claims it.

Written in TypeScript for [Deno](https://deno.com). Zero dependencies:
the Hacker News API client, the digest builder, and the SMTP client
are all in one file, `hn_digest.ts`.

![A day's digest, arranged by category](https://github.com/roberto-morado/hn-daily-digest/releases/download/v1.0.0/digest-sample.png)

## Tutorial: run it on GitHub Actions

This is the set-and-forget route. GitHub runs the digest every day at
12:00 UTC and emails it to you. You need a mail account that allows
SMTP sending; the steps below use Gmail as the example.

1. **Fork this repository** (or copy its files into a new repo of your
   own).
2. **Get a Gmail App Password.** Google does not allow your normal
   account password for SMTP. Turn on 2-Step Verification, then go to
   Google Account → Security → App passwords and create one for this
   app. Keep it for step 3.
3. **Enter your settings as repository secrets.** In your fork, open
   Settings → Secrets and variables → Actions → New repository secret,
   and add each of these:

   | Name        | Value                                   |
   | ----------- | --------------------------------------- |
   | `SMTP_HOST` | `smtp.gmail.com`                        |
   | `SMTP_PORT` | `465`                                   |
   | `SMTP_USER` | your Gmail address                      |
   | `SMTP_PASS` | the App Password from step 2            |
   | `MAIL_FROM` | your Gmail address                      |
   | `MAIL_TO`   | the address that receives the digest    |

4. **Run it once by hand.** Open the Actions tab, choose "Daily Hacker
   News digest", and press "Run workflow". A green check means the
   digest was sent. From then on it runs daily on its own; to change
   the hour, edit the `cron` line in `.github/workflows/daily-digest.yml`.

Your secrets stay in GitHub's encrypted store. They are never written
in the code, and GitHub masks them in the workflow logs.

## Tutorial: run it locally

You need [Deno](https://deno.com) installed.

```sh
deno task setup    # asks for your settings and writes them to .env
deno task dry-run  # prints the digest instead of sending it
deno task run      # fetches and sends the digest now
```

The `.env` file is git-ignored. Never commit it.

## How it works

- Reads the six feeds from the official
  [Hacker News API](https://github.com/HackerNews/API):
  `topstories`, `beststories`, `newstories`, `askstories`,
  `showstories`, `jobstories`. It scans the first 100 ids of each.
- **Top Stories** takes 15 stories and **Best Stories** 5; both keep a
  50-point floor and are sorted by score. **New Stories**, **Ask HN**,
  and **Show HN** take 5 each, ranked by score inside their own feed,
  with no floor. **Jobs** takes 5 in feed order; job posts carry no
  score, so they are listed by title, link, and poster.
- A story claimed by an earlier section never repeats in a later one.
- Builds a plain-text and an HTML part with the same arrangement and
  sends both over SMTP (port 465 for implicit TLS, 587 for STARTTLS).

## Settings

No address or password is hardcoded anywhere. The script reads its
settings from environment variables or from a local `.env` file.

| Setting       | Meaning                                |
| ------------- | -------------------------------------- |
| `SMTP_HOST`   | SMTP server, e.g. `smtp.gmail.com`     |
| `SMTP_PORT`   | `465` (TLS) or `587` (STARTTLS)        |
| `SMTP_USER`   | SMTP login                             |
| `SMTP_PASS`   | SMTP password (for Gmail, an App Password) |
| `MAIL_FROM`   | From address                           |
| `MAIL_TO`     | Address that receives the digest       |

Optional tuning: `DIGEST_COUNT` (Top Stories count, default 15) and
`DIGEST_MIN_SCORE` (floor for the Top and Best sections, default 50).
