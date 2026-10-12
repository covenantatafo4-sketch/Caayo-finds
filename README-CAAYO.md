# CAAYO — Ecommerce Store

CAAYO is a black-and-white ecommerce storefront with an admin panel for importing products from public Pinduoduo/Yangkeduo URLs. No Pinduoduo API key is required.

## Files
- `index.html` — customer storefront (mobile-first, matches the CAAYO app design): menu drawer, live search, hero slider, 5 category tiles, Under #1000 row with See All, product detail sheet, cart drawer, checkout, account/orders and a 5-tab bottom nav. Products come from the backend; if it has none (or is unreachable) four demo products are shown.
- `admin.html` — admin login, product URL importer, image gallery preview, editing, publishing, hide/show, rating fields and an Orders list.
- `server.js` — Express backend, product/order APIs (orders are priced server-side) and URL importer.
- `package.json` — Node/Express dependencies and start command.
- `README-CAAYO.md` — setup instructions.

## Product workflow
1. Open `/admin`.
2. Log in with `ADMIN_PASSWORD`.
3. Paste a Pinduoduo/Yangkeduo product URL.
4. Click **IMPORT LINK**.
5. The backend attempts to resolve the URL and extract title, description, main image, additional gallery images and source price when publicly available.
6. Review/edit the imported information and set the CAAYO selling price.
7. Click **PUBLISH TO CAAYO**.
8. The storefront loads the published product and its image(s) from `/api/products`.

## Product images
Product imagery is not hard-coded into the storefront. The storefront uses the image data supplied by the backend (`image` and `images`). Each product's images can therefore come from the product URL imported in the admin panel. If the source page does not expose usable images, image URLs can be entered manually in the admin panel.

## Categories
The storefront includes Accessories, Men Clothing, Gadgets, Women Clothing and Under ₦1,000. Use matching category values when publishing products.

## Local setup
```bash
npm install
ADMIN_PASSWORD="your-strong-password" npm start
```
Storefront: `http://localhost:3000/`
Admin: `http://localhost:3000/admin`

## Render
Build Command: `npm install`
Start Command: `npm start`
Set `ADMIN_PASSWORD` in Render Environment Variables. The server binds to `0.0.0.0` and uses Render's `PORT`.

## Cloudflare frontend
When served from localhost or onrender.com the storefront uses the same origin. Otherwise it points API requests to `https://caayo-finds.onrender.com`. If the backend URL changes, update `CAAYO_API` in `index.html`. Keep the Express backend on a Node-compatible host.

## Importer limitation
Pinduoduo/Yangkeduo can restrict automated requests or hide data behind JavaScript, login or anti-bot protections. This importer does not bypass those protections. If automatic extraction fails, use the manual product fields while keeping the source URL.

## Storage
The backend creates `data/products.json` and `data/orders.json` automatically. JSON storage is suitable for the current prototype/testing stage; move to persistent database storage for a larger production deployment.


## Security and translation (latest update)

- The admin panel is only reachable by typing `/admin` in the address bar. The storefront has no link to it.
- **You must set `ADMIN_PASSWORD`** on your server (Render > Environment). Until you do, admin login is disabled.
- Admin login allows 5 wrong tries, then locks that device for 15 minutes. Sessions last 12 hours and end when the browser tab closes.
- `server.js` serves only the storefront, `/admin` and `/uploads`. Your code and order data are no longer public.
- Chinese product names and descriptions are translated to English when you import or publish, and again on the storefront for any older product. By default this uses the free MyMemory service. For better quality and no daily limit, set `GOOGLE_TRANSLATE_API_KEY` (Google Cloud Translation). Optional: `MYMEMORY_EMAIL` raises MyMemory's free limit.
- Imported product photos are copied to your own server so they do not break. Set `UPLOAD_DIR` to a persistent disk to keep them across redeploys.

## Link import (latest)

- The link import keeps the original fetch that worked first, and only tries extra methods if that gets no product. Paste any public product link in admin (Pinduoduo, 1688, AliExpress or a normal shop). The server pulls the name, description, detail lines (material, colour, options, seller, sales), price and keywords. It also picks up any product photos it finds (never Pinduoduo's own logo), and photos you upload yourself are always kept.
- Anything not in English is translated automatically. The order is Google Cloud Translation (if `GOOGLE_TRANSLATE_API_KEY` is set), then Google's free web endpoint, then MyMemory. The free web endpoint is unofficial, so add the API key for a dependable setup.
- Pinduoduo often refuses requests from servers. When that happens admin tells you, and you type the name and description yourself; the Translate button converts them to English.

## Paystack payments

- Add `PAYSTACK_SECRET_KEY` (from Paystack Dashboard > Settings > API Keys & Webhooks) in your server's environment. Use the `sk_test_...` key first, then the `sk_live_...` key when your Paystack business is approved.
- In the same Paystack page set the **Webhook URL** to `https://YOUR-RENDER-ADDRESS/api/paystack/webhook`.
- The server works out the amount from your product prices, sends the customer to Paystack, then confirms the payment with Paystack before marking the order **paid**. Orders show as pending or paid in admin.
- Without the key, orders are still saved as pending with no payment step.

## Shop features (guest checkout, delivery, shipping, order emails)

- **No account needed.** Customers check out with an email. Orders and details are remembered on their own device only.
- **Delivery:** state dropdown for all 36 states and FCT, then popular areas. Lagos, Delta, Ondo and Edo are free. Every other state pays an additional dispatch fee: set the amount in admin under "Shipping & email settings" (0 means "we confirm the amount with the customer"). Custom locations are routed to +2349055810160.
- **Shipping:** Standard is 2 to 3 months and included. Express is 7 to 10 days at $9/kg for normal products and $21/kg for special and battery products, charged in naira using the dollar rate you set in admin. Set each product's weight and type in the product form.
- **Order emails** go to the customer's checkout email when the order is confirmed and every time you change the stage in admin (Orders list, "Update & email customer"): packaged, loaded onto the ship, left the port, arrived in Nigeria, out for delivery, delivered. The wording lives in the `STAGES` list in `server.js`.
- **Set up email** (pick one) in your server's environment, plus `EMAIL_FROM`, for example `CAAYO <orders@yourdomain.com>`:
  - `BREVO_API_KEY` (Brevo: verify your sender email or domain first), or
  - `RESEND_API_KEY` (Resend: needs a verified domain to email customers).
- **Tracking:** customers use Track my order with the order ID and email. Links in emails open it directly.
- Also: wishlist, sorting, share link, recently viewed, related products, help and delivery info.

## Delivery rules (latest)

- **Pickup is free.** Add pickup points in admin under "Delivery, shipping & email settings", one per line: `Name | State | Area | Address`. If you add none, customers only see door delivery.
- **Door delivery is paid** unless the order's item total reaches the free-delivery minimum (default 100,000 naira, change it in admin). Set the door fee for Lagos, Delta, Ondo and Edo, and a separate fee for the other states. A fee of 0 means "we confirm the amount with the customer" and nothing extra is charged online.
- By default the free-delivery minimum applies only to Lagos, Delta, Ondo and Edo. Tick the box in admin to apply it to every state.
- Express shipping (7 to 10 days) is a separate charge and does not count toward the minimum.
- Pickup orders get their own wording: "Ready for pickup" and "Collected" in emails and tracking.

## Colours, sizes and categories

- **Colours:** when you upload a product photo in admin, the browser works out the main colour of the product (ignoring the plain background and skin tones) and adds it under "Colours". It is a good guess, not perfect, so check the names. Delete rows for photos that are not a different colour. Customers choose a colour on the product page, and tapping a colour jumps to that photo.
- **Sizes:** pick a size type per product: Shoes Adult (20 to 50), Shoes Kids (16 to 35), Clothing Adult (XS to 4XL), Clothing Kids (by age), or Custom. Then tap only the sizes you have. Customers must choose a size before adding to cart.
- **Categories:** admin has a dropdown with the full list (Clothing, Shoes, Bags, Gadgets, Computing, Home & Kitchen, Appliances, Beauty, Health, Jewelry & Watches, Accessories, Baby & Kids, Toys & Games, Sports, Automotive, Tools, Office & School, Pets, Party & Gifts, each with sub-categories). The Categories tab on the store shows them all. The list lives in `admin.html` and `index.html` (`CAT_TREE` and `TREE`) if you want to add more.
- The chosen colour and size are saved on each order line, shown in admin, in emails and in tracking.

- Clothing sizes: S, M, L, XL, 2XL up to 5XL for shirts, tops and clothes, and waist sizes 26 to 46 for trousers and jeans. New sub-categories: Shirts & Tops, Trousers & Jeans, Dresses & Skirts, Jackets & Hoodies.

- **Home page banners:** in admin, the "Home page banners" card lets you add a picture and write the small top line, headline, text and button for each banner at the top of the storefront (where the CAAYO shopping bag is). Up to 5 banners slide automatically; an empty banner keeps the built-in default. Saved in `data/settings.json` (pictures in `UPLOAD_DIR`).

## Free hosting that keeps your data (Render free + free database)

Render's free web service wipes its local files on every restart, redeploy and sleep. To keep products, orders, settings, banners and uploaded photos, use a free Postgres database:

1. Create a free account at **neon.tech** (or Supabase) and create a project. Copy the connection string (starts with `postgresql://`).
2. In Render > your service > Environment, add `DATABASE_URL` = that connection string. Redeploy.
3. Open `https://YOUR-SITE/health`. It should say `"storage":"database"`. If it says `files`, the variable is not set.
4. First start with a database imports any products already saved on the server, then everything is stored in the database. Photos you upload are stored there too (resized, so a small shop fits comfortably in a free plan; check your provider's current free limit).
5. Free services sleep after 15 minutes without visitors and take about a minute to wake. To avoid this, add a free monitor (UptimeRobot) that opens `https://YOUR-SITE/health` every 5 minutes, or use Render's paid Starter instance.

Without `DATABASE_URL` the store still works using local files, for testing only.
