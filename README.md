<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/67e297c0-0cb8-46d6-99d0-6c27e6e35f67

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Build the frontend:
   `npm run build`
4. Start the backend proxy and static server:
   `npm run start`

The app will be available on `http://localhost:4173`.

## Development

- Frontend dev server: `npm run dev`
- Backend proxy/static server: `npm run start`
- Cloudflare Pages local dev: `npm run cf:dev`

When using the Vite dev server, `/api/*` requests are proxied to `http://127.0.0.1:4173`.

## Deploy To Cloudflare Pages

This project is prepared for **GitHub -> Cloudflare Pages** deployment.

Cloudflare build settings:

- Framework preset: `Vite`
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `物性论os` (if the repo root is `/Users/beijisheng/Desktop/420`)

Cloudflare environment variables:

- `GEMINI_API_KEY`

Cloudflare runtime notes:

- API routes live in [`functions/api`](./functions/api)
- SPA fallback is handled by [`functions/[[path]].ts`](./functions/[[path]].ts)
- Wrangler config lives in [`wrangler.toml`](./wrangler.toml)

After the first successful Pages deploy:

1. Add `longone.ai` in Cloudflare Pages custom domains.
2. In Firebase Auth authorized domains, add:
   - `longone.ai`
   - `www.longone.ai` if you use it
   - your `*.pages.dev` preview/production domain if login needs to work there too
