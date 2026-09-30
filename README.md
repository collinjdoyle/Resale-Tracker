# Resale Tracker

A small, phone-first web app for tracking resale inventory and profit (Vinted, Facebook Marketplace, eBay, Amazon...).

## What it does
- **Add items fast** - scan a barcode (UPC/EAN) or photograph it, and the details are filled in. Photos of the item itself show look-alikes you already have, so repeats are easy to spot.
- **Quantity** - buy 6 of something, sell them in pieces; the stock count and profit track it per sale.
- **Add again / history** - "Add something I've had before" (or "Add again" on any item) copies the details and photos; you only enter how many and what you paid this time.
- **Mark sold in seconds** - search, or *Find by photo*; enter price, platform, fees (pre-filled from editable presets) and shipping; live profit preview. Every sale is kept in the **Sold** history and can be edited or undone.
- **Dashboard** - profit after expenses, monthly goal bar, profit-by-month chart, average profit and time to sell, best places to buy, by platform. CSV exports.
- **Stock health** - days in stock, *Stale 60d+* filter, asking price.
- **Expenses and mileage** - gas/supplies/fees and miles (editable per-mile rate), subtracted from profit.

Works as a home-screen app on iPhone/Android (Add to Home Screen); sidebar layout on iPad/desktop.
Stack: Node 22 + Express, SQLite (`node:sqlite`, no native deps), vanilla JS. Everything lives in one folder: `/data`.

## Barcodes
1. Your own history first (any barcode you have added before fills in instantly).
2. UPCitemdb - good for toys. The free tier allows roughly 100 lookups/day; results are cached, and the app tells you when the limit is hit. Set `UPCITEMDB_KEY` for more.
3. Open Products Facts, then Open Food Facts (mostly groceries).

Reading the barcode: Chrome/Android uses the built-in detector. iPhone (and everything else) uses a bundled reader (`public/vendor`, Quagga2, MIT) that also works on a *photo* of the barcode. **Live camera scanning needs HTTPS**; *Take photo* works over plain HTTP.

## Photo look-alikes (no AI)
Each photo gets a tiny fingerprint (shape + colour) computed in the browser. Matching is basic on purpose: it shows the closest few items you already have and you pick the right one. It can't identify a brand-new item - use the barcode for that.

## Run locally
```bash
npm install
node --env-file=.env src/server.js
```

## Deploy on Unraid
1. Push to GitHub (`main`). The workflow in `.github/workflows/docker.yml` publishes `ghcr.io/<you>/resale-tracker:latest`.
2. Make the package public (Profile -> Packages -> resale-tracker -> Package settings), or `docker login ghcr.io` on Unraid.
3. Unraid -> Docker Compose Manager -> new stack named `resale-tracker` (no apostrophes or spaces anywhere in the name/description) -> paste `docker-compose.yml`, set a password and a long random `SESSION_SECRET`.
4. Compose Up, open `http://<unraid-ip>:3000`, Add to Home Screen.
5. Update: push, wait for the Action to go green, then pull and Up again.

Back up `/mnt/user/appdata/resale-tracker` (database + photos). Do not expose the app to the internet without HTTPS and a password.

## Optional AI extras
Off by default. With `AI_PROVIDER=ollama` (or `anthropic`) the Add screen also guesses title/brand from a photo and each item gets a listing-text writer. Needs a vision model (e.g. `qwen2.5vl:3b`); slow on old GPUs. Not needed for normal use.
