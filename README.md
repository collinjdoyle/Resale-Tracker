# Resale Tracker

A small, phone-first web app for tracking resale inventory and profit (Vinted, Facebook Marketplace, eBay, Amazon…).

- **Add items fast** – snap a photo and the AI fills in title/brand/category/condition; scan a barcode (UPC/EAN) or type it in.
- **Duplicate check** – photo or UPC is compared with what's already in stock, so you can open the existing item instead of adding another.
- **Mark sold in seconds** – search, or *Find by photo*; enter sold price, platform, fees (pre-filled from presets, always editable) and shipping; live profit preview.
- **Dashboard** – profit, revenue, stock value, by platform and by month. CSV export.
- Works as a home-screen app on iPhone/Android (Add to Home Screen); sidebar layout on iPad/desktop.

Stack: Node 22 + Express, SQLite (`node:sqlite`, no native deps), vanilla JS. Data (db + photos) lives in one folder: `/data`.

## Run locally

```bash
npm install
cp .env.example .env   # edit; export the vars or use: node --env-file=.env src/server.js
node --env-file=.env src/server.js
```

## Deploy on Unraid

1. Push this folder to a **private GitHub repo** named `resale-tracker` (branch `main`).
   The included workflow (`.github/workflows/docker.yml`) builds and pushes `ghcr.io/<you>/resale-tracker:latest` on every push.
2. In GitHub → Packages → resale-tracker, either make it public, or on Unraid run `docker login ghcr.io` with a read-only PAT.
3. Unraid → Docker Compose Manager → *Add New Stack* → paste `docker-compose.yml` (set your GitHub user), and set the env values from `.env.example` in the stack's env file.
4. *Compose Up*, then open `http://<unraid-ip>:3000` on her phone and Add to Home Screen.
5. To update: push to GitHub, then *Compose Pull* + *Up* on Unraid.

No registry? Use option B in the compose file (`build: https://github.com/<you>/resale-tracker.git#main`) — Unraid builds it itself.

Back up `/mnt/user/appdata/resale-tracker` (it holds everything).

### HTTPS / camera note
Browsers only allow **live barcode scanning** and some camera features on HTTPS (or localhost). The *Take photo* button works over plain HTTP, and the app also reads barcodes from a photo where the browser supports it (Android Chrome). For iPhone, put it behind a reverse proxy with HTTPS (Nginx Proxy Manager / Tailscale serve / Cloudflare Tunnel) — and don't expose it publicly without a password (`APP_PASSWORD`).

## Photo recognition
Set `AI_PROVIDER` to:
- `anthropic` – Claude vision via `ANTHROPIC_API_KEY` (fractions of a cent per photo with Haiku).
- `ollama` – your own server, e.g. `OLLAMA_URL=http://<host>:11434` with a vision model (`qwen2.5vl`, `llama3.2-vision`).
- `none` – manual entry + UPC lookup only.

UPC lookups use UPCitemdb (free tier, rate limited; optional `UPCITEMDB_KEY`) then Open Food Facts.
Coverage for clothing/thrift items is patchy, which is why photo ID exists.

## Notes / ideas for later
- Fee presets are approximations (eBay ≈13.6% + $0.40, FB 10% shipped, Vinted 0% seller fee, Amazon 15%) — edit them on the Home tab; the actual fee per sale is always editable.
- One sale per item (no quantities/lots yet). Returns: use *Mark as unsold*.
