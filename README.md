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

## Deploy To Cloudflare Workers

This project is prepared for **GitHub -> Cloudflare Workers** deployment using static assets plus a Worker entrypoint.

Cloudflare deployment settings:

- Worker name: `longone-ai`
- Root directory: `物性论os` (if the repo root is `/Users/beijisheng/Desktop/420`)
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`

Cloudflare environment variables:

- `GEMINI_API_KEY`

Cloudflare runtime notes:

- Primary runtime entrypoint is [`worker/index.ts`](./worker/index.ts)
- Static assets are served from `dist` via [`wrangler.toml`](./wrangler.toml)
- Legacy `functions/api` files are old Pages-era artifacts and are not the active deployment path

Recommended Cloudflare setup:

1. In Cloudflare, go to `Workers & Pages`.
2. Create or open the Worker named `longone-ai`.
3. In `Settings -> Builds`, connect the GitHub repository.
4. Set the build root to `物性论os`.
5. Ensure the Worker name in Cloudflare matches `name = "longone-ai"` in `wrangler.toml`.
6. Add `GEMINI_API_KEY` as a production secret/environment variable.
7. Push to `main` to trigger automatic production deploys.

After the first successful deploy:

1. Add `longone.ai` in Cloudflare custom domains/routes.
2. In Firebase Auth authorized domains, add:
   - `longone.ai`
   - `www.longone.ai` if you use it
   - your Cloudflare preview/production `workers.dev` domain if login needs to work there too

Firebase Auth local development note:

- For local login, add `localhost` under `Authentication -> Settings -> Authorized domains`.
- Do not enter `localhost:4173` or `http://localhost:4173`; Firebase expects the host only.
