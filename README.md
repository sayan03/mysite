# Bengali Trading PDF Store: Stormkit edition

Stormkit runs serverless functions + a CDN. There is **no persistent disk**, so this version uses
**Supabase Postgres** (data) and a **private Supabase Storage bucket** (PDFs).

## Structure
server.js (Express API) · entry.mjs (serverless wrapper) · build.js (bundles to `.stormkit/`) · schema.sql · public/ (storefront, success, failed, legal, admin.html)

## 1. Supabase
1. New project → SQL editor → run `schema.sql`.
2. Storage → create bucket **`pdfs`** → keep it **Private**. Upload PDFs there (dashboard upload; serverless request limits make big uploads through the app unreliable).
3. Copy: DB connection string (use the *pooler*, port 6543) → `DATABASE_URL`; Project URL → `SUPABASE_URL`; `service_role` key → `SUPABASE_SERVICE_KEY` (backend only, never in frontend).

## 2. Razorpay
API keys (test first) → `RAZORPAY_KEY_ID/SECRET`. Webhooks → URL `https://YOUR-DOMAIN/api/webhook`, events `payment.captured`, `order.paid`, `payment.failed`, secret → `RAZORPAY_WEBHOOK_SECRET`.

## 3. Deploy on Stormkit
1. Push this folder to GitHub/GitLab/Bitbucket → app.stormkit.io → import repo.
2. Production environment → Edit:
   - Build command: `npm run build`
   - Static output: `.stormkit/public`
   - Server (serverless) output: `.stormkit/server` (handler exported from `server.mjs`). Turn the **Serverless** toggle on.
   - Add every variable from `.env.example` (BASE_URL = your final domain).
3. Deploy, attach your domain (HTTPS), update `BASE_URL` and the Razorpay webhook URL.
4. Stormkit's settings screens change, so if a field name differs, check docs.stormkit.io.

## 4. Admin
`ADMIN_PASSWORD_HASH`: `node -e "console.log(require('bcryptjs').hashSync('YourPassword',12))"`. Open `/admin.html`. Add each product: price, discount, **PDF path** (e.g. `candlestick.pdf`, the object name in the `pdfs` bucket), cover image URL. Create one product with type **Bundle** (no PDF path needed): buying it grants every active PDF.

## 5. Secure delivery
Bucket is private. `/api/download/:token` checks paid order, expiry, max downloads (atomic counter), then redirects to a **60-second signed URL**.

## Test before going live (Razorpay test mode)
Pay → success page → email → download; failed payment; coupon; webhook (close the tab right after paying); download limit/expiry. Webhook raw-body handling under the serverless wrapper is the first thing to verify.

## Known gaps
Rate limits are per serverless instance (weak): add Cloudflare/WAF rules for login and checkout. Legal pages are placeholders (lawyer review). `/product/slug` pages not built. No admin CSRF token beyond SameSite cookies. Confirm resale rights for every PDF.
