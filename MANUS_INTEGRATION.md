# Connecting the scraper to your Manus app

> **PriceSmart:** the ingest endpoint, database tables and Grocer.nz switch-over are already built into the PriceSmart code (see `PRICESMART_SCRAPER_INTEGRATION.md` in the app). Skip Step 3 and Step 7 below; do Steps 1, 2 and 4–6.

## How the pieces fit

```
 GitHub Actions (free, daily at ~2-3am NZ)          Your Manus app
 ┌──────────────────────────────────┐   HTTPS POST   ┌──────────────────────────────┐
 │ nz-grocery-scraper                │ ─────────────▶ │ POST /api/ingest/prices       │
 │  • scrapes all 5 chains           │  JSON batches  │  • checks INGEST_SECRET       │
 │  • sends only prices that changed │  + secret      │  • upserts into the database  │
 └──────────────────────────────────┘                │ Your comparison pages read    │
                                                     │ current_prices/price_history  │
                                                     └──────────────────────────────┘
```

The scraper runs **outside** Manus. A 2-hour daily job isn't a good fit for a web app's server, and GitHub Actions runs it for free. Your Manus app only needs one new endpoint that receives the data.

---

## Step 1: Decide how many stores to start with

Every store in every chain is about **2.5 million price rows**. After the first day, only changes are sent, typically a few hundred thousand rows a day, mostly weekly specials turning over. That is a lot for a starter database. **Check the database limits on your Manus plan.** I recommend starting with one region and expanding later. Examples:

| GitHub variable | Example value |
|---|---|
| `NEW_WORLD_STORES` | `Albany,Victoria Park,Remuera` |
| `PAKNSAVE_STORES` | `Albany,Royal Oak,Sylvia Park` |
| `FRESHCHOICE_STORES` | `Avondale,Mangere Bridge` |

The values are parts of store names; leave a variable unset for all stores. To see every store name, run the scraper once locally with `--max-pages 1`, then open `output/<date>/prices-*.ndjson.gz`. Or look at the store list your app receives. Woolworths always sends one national store.

## Step 2: Create a shared secret

Run this on your PC and copy the output. It is the password the scraper uses to talk to your app.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 3: Ask Manus to build the ingest endpoint

Open your app in Manus and paste the prompt below. Replace `<PASTE SECRET HERE>` with the secret from Step 2.

````text
I have an external price scraper (running on GitHub Actions) that will send New Zealand supermarket
prices to my app once a day. Please add a data-ingest endpoint and database tables for it.
Do not change or remove any existing features.

## 1. Secret
Add a server-side environment secret INGEST_SECRET with the value: <PASTE SECRET HERE>
Never expose it to the frontend.

## 2. Database tables (MySQL-compatible; use the project's existing ORM, e.g. Drizzle, and generate a migration)

stores
  chain        VARCHAR(20)  NOT NULL   -- woolworths | new_world | paknsave | freshchoice | supervalue
  store_id     VARCHAR(64)  NOT NULL
  name         VARCHAR(255) NOT NULL
  region       VARCHAR(20)  NULL
  address      VARCHAR(500) NULL
  latitude     DOUBLE       NULL
  longitude    DOUBLE       NULL
  url          VARCHAR(500) NULL
  updated_at   DATETIME     NOT NULL
  PRIMARY KEY (chain, store_id)

current_prices   -- one row per product per store: the latest known price
  chain              VARCHAR(20)   NOT NULL
  store_id           VARCHAR(64)   NOT NULL
  product_id         VARCHAR(64)   NOT NULL
  name               VARCHAR(500)  NOT NULL
  brand              VARCHAR(255)  NULL
  size_text          VARCHAR(100)  NULL
  size_value         DOUBLE        NULL
  size_unit          VARCHAR(10)   NULL      -- g | ml | ea
  sold_by            VARCHAR(10)   NOT NULL  -- each | kg  (kg = prices are per kilogram)
  barcode            VARCHAR(32)   NULL
  category           VARCHAR(500)  NULL
  price              DECIMAL(10,2) NOT NULL  -- price anyone pays for 1 unit, specials included
  regular_price      DECIMAL(10,2) NULL      -- normal non-promo price
  member_price       DECIMAL(10,2) NULL      -- loyalty-card price (Clubcard / Everyday Rewards)
  multibuy_qty       INT           NULL      -- e.g. 3 ...
  multibuy_total     DECIMAL(10,2) NULL      -- ... for $5.00
  on_special         BOOLEAN       NOT NULL DEFAULT FALSE
  promo_label        VARCHAR(255)  NULL
  unit_price         DECIMAL(10,2) NULL
  unit_price_measure VARCHAR(50)   NULL      -- e.g. 100g, 1kg, 1L
  in_stock           BOOLEAN       NULL
  image_url          VARCHAR(1000) NULL
  product_url        VARCHAR(1000) NULL
  match_key          VARCHAR(500)  NULL      -- groups the same product across chains
  active             BOOLEAN       NOT NULL DEFAULT TRUE
  first_seen_at      DATETIME      NOT NULL
  last_changed_at    DATETIME      NOT NULL
  scraped_at         DATETIME      NOT NULL
  PRIMARY KEY (chain, store_id, product_id)
  INDEX (match_key(191)), INDEX (barcode), INDEX (chain, product_id), INDEX (store_id, active)

price_history   -- one row per product per store per day on which its price changed
  id             BIGINT AUTO_INCREMENT PRIMARY KEY
  chain          VARCHAR(20)   NOT NULL
  store_id       VARCHAR(64)   NOT NULL
  product_id     VARCHAR(64)   NOT NULL
  price_date     DATE          NOT NULL   -- New Zealand date (Pacific/Auckland) of scraped_at
  price          DECIMAL(10,2) NOT NULL
  regular_price  DECIMAL(10,2) NULL
  member_price   DECIMAL(10,2) NULL
  multibuy_qty   INT           NULL
  multibuy_total DECIMAL(10,2) NULL
  on_special     BOOLEAN       NOT NULL DEFAULT FALSE
  UNIQUE KEY (chain, store_id, product_id, price_date)

scrape_runs
  id           BIGINT AUTO_INCREMENT PRIMARY KEY
  run_id       VARCHAR(100) NOT NULL
  chain        VARCHAR(20)  NOT NULL
  completed_at DATETIME     NOT NULL
  ok           BOOLEAN      NOT NULL
  stats        JSON         NOT NULL
  UNIQUE KEY (run_id, chain)

## 3. Endpoint: POST /api/ingest/prices
This must be a plain REST route on the Express server (not tRPC, and no user login), because it is
called by an external job. Allow JSON bodies up to 10 MB on this route.

Auth: require header `Authorization: Bearer <INGEST_SECRET>`; compare with a timing-safe comparison.
Return 401 if missing or wrong.

Request body:
{ "runId": string, "chain": string, "kind": "stores"|"prices"|"removed"|"run_complete",
  "scrapedAt": ISO string, "items": array, "stats"?: object }
Return 400 if runId, chain, kind or items are missing or invalid.

Behaviour by kind (each request in ONE transaction, using bulk statements, not one query per row;
batches contain up to 500 items and should finish in a few seconds):
- "stores": upsert every item into `stores` (set updated_at = now).
- "prices": items are price records with exactly the column names of current_prices
  (chain, store_id, product_id, name, brand, size_text, size_value, size_unit, sold_by, barcode,
  category, price, regular_price, member_price, multibuy_qty, multibuy_total, on_special, promo_label,
  unit_price, unit_price_measure, in_stock, image_url, product_url, match_key, scraped_at).
  1. Load the existing current_prices rows for the batch's keys in a single query.
  2. Upsert all items into current_prices with active = TRUE. For new rows set first_seen_at =
     scraped_at. Set last_changed_at = scraped_at when the row is new or any of price, regular_price,
     member_price, multibuy_qty, multibuy_total changed; otherwise keep the old value.
  3. For rows that are new or changed, upsert into price_history keyed by
     (chain, store_id, product_id, price_date), where price_date is the Pacific/Auckland date of scraped_at.
     If a row already exists for that day, overwrite it.
- "removed": items are {store_id, product_id}; set active = FALSE for (chain, store_id, product_id).
- "run_complete": upsert a scrape_runs row (run_id, chain, completed_at = now,
  ok = stats.ok, stats = the stats object).
Respond 200 with { "ok": true, "received": <items.length> }.
The endpoint MUST be idempotent: the scraper retries, so the same batch can arrive more than once.
Log errors server-side and return 500 on failure so the scraper retries.

## 4. Admin status page
Add an admin-only page "Price data status" showing the latest scrape_runs row per chain
(completed_at, ok, stats.products, stats.changed, stats.removed, stats.stores_failed) and the total
number of active rows in current_prices per chain.

When done, tell me the full public URL of the endpoint.
````

Once Manus finishes, **publish/deploy the app**. The endpoint must be reachable on your public URL, for example `https://your-app.manus.space/api/ingest/prices`, not just the preview. Note the full endpoint URL.

## Step 4: Put the scraper on GitHub

1. Create a free account at <https://github.com>. Then click **New repository**, name it `nz-grocery-scraper`, and choose **Public**. Public repos get unlimited free Actions minutes. The code contains no secrets, because those go in step 5. A private repo gets 2,000 free minutes a month, which is **not enough** for a daily all-stores run of about 100 minutes.
2. On the new repo's page, click **uploading an existing file** and drag in the *contents* of the `nz-grocery-scraper` folder. The web uploader skips hidden folders, so also create the workflow file by hand: click **Add file → Create new file**, name it `.github/workflows/daily-scrape.yml`, and paste in the contents of that file.

## Step 5: Add the secret and URL to GitHub

In the repo, open **Settings → Secrets and variables → Actions**:

- **Secrets** tab → **New repository secret**:
  - `INGEST_URL` = `https://your-app.manus.space/api/ingest/prices`
  - `INGEST_SECRET` = the secret from Step 2
- **Variables** tab (optional; limits which stores are scraped, see Step 1):
  - `NEW_WORLD_STORES`, `PAKNSAVE_STORES`, `FRESHCHOICE_STORES`, `SUPERVALUE_STORES`, `CHAINS`

## Step 6: Test run

1. In the repo, open **Actions → Daily NZ grocery prices → Run workflow**.
2. Set **Max stores per chain** to `1`, then click **Run workflow**. It takes about 10 minutes.
3. When it finishes, check:
   - The run log ends with a summary where every chain says `OK`.
   - Your app's **Price data status** page shows five chains and roughly 17k (Woolworths), 10–12k (New World / PAK'nSAVE), and 3–7k (FreshChoice / SuperValue) products.
   - Under the run's **Artifacts** you can download the raw files.

If the log shows `ingest … failed: HTTP 401`, the secrets don't match. `HTTP 404` means the URL is wrong or the app isn't published. `HTTP 413` means the body limit is too small, so ask Manus to raise it.

After that, the schedule runs by itself every night at about 2–3am NZ time. The first full run sends everything; after that only changes are sent, and every Sunday it re-sends everything to self-heal any drift.

## Step 7: Use the data in your app

Your app already has its own screens, so the second prompt connects them to the new tables. Adjust it to match what your app does.

````text
My database now has real supermarket prices in the tables stores, current_prices and price_history
(filled daily by the /api/ingest/prices endpoint). Please switch the app's product search and price
comparison to use this data instead of any sample/mock data. Rules:
- Only show rows where current_prices.active = TRUE.
- Let the user choose their stores (default: nearest New World, PAK'nSAVE and FreshChoice by
  latitude/longitude, plus Woolworths store_id 'online'). Remember the choice per user.
- Treat products as "the same product" across chains when barcode matches, otherwise when match_key
  matches. Also add a table product_matches(group_id, chain, product_id) plus an admin screen where I
  can manually link or unlink products; manual links override the automatic matching.
- Effective price for comparison = the lowest of: price; member_price (only if the user said they have
  that chain's loyalty card: Clubcard for New World/PAK'nSAVE, Everyday Rewards for Woolworths);
  multibuy_total / multibuy_qty (show it as "3 for $5").
- When sold_by = 'kg', show the price as "$X/kg".
- Compare by unit_price + unit_price_measure when sizes differ.
- Show a price-history chart per product from price_history.
- Show the time of the last successful update per chain (from scrape_runs) so users know how fresh prices are.
````

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| One chain says `FAIL` with an HTTP 403 or a parsing error | That supermarket changed its website. The other chains still work. The code to update is in `src/scrapers/<chain>.js`. |
| `warning: … collected X of Y listed products` | A very large FreshChoice/SuperValue store; about 96% coverage is expected there. |
| GitHub stopped running the schedule | GitHub disables schedules in repos with no activity for 60 days. Re-enable it on the Actions tab, or push any small commit. |
| Database is getting big | Limit stores (Step 1), or delete `price_history` rows older than N months. |
| Want to force a full resend | Actions → Run workflow → tick **Send every price**. |
