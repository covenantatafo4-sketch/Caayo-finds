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
The storefront calls the server on its own address, so a custom domain needs no code change. Only when it is opened from a Cloudflare workers.dev or pages.dev address does it use `https://caayo-finds-tr6y.onrender.com`. If the backend URL changes, update `CAAYO_API` in `index.html`. Keep the Express backend on a Node-compatible host.

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

## Moving to your own domain later
1. Render > your service > Settings > Custom Domains > Add, then add the DNS records Render shows at your domain registrar. Wait for the green tick.
2. Render > Environment: change `PUBLIC_URL` to `https://yourdomain.com` and Save and deploy.
3. Paystack > Settings > API Keys & Webhooks: change the Webhook URL to `https://yourdomain.com/api/paystack/webhook`.
4. Brevo: verify the domain (Senders, Domains) and use an address on it in `EMAIL_FROM`.
Nothing else changes. Products, orders and photos stay in the database.

## Order emails with Mailjet (free)
Render > Environment: add `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` and `EMAIL_FROM` (as `CAAYO <your-verified-email>`), then Save and deploy. In admin > Orders use "Send test email". Mailjet is used first if its keys are present; otherwise Brevo, then Resend.

## Admin dashboard (tabs)
Orders, Products, Add / edit product, Reviews, Homepage (banners), Settings (delivery, email test).

## Products: options with prices, colours, labels
- Each colour can have its own photo: tap the picture box on the colour row, pick from the product photos or add one from your gallery.
- "Options with their own price" is optional: e.g. Storage 64GB / 128GB / 256GB, each with its own price. Customers must choose one and pay that option's price (the server sets the price). The cheapest option is the "From" price.
- Condition (Brand new, Refurbished, Used, Open box) and labels (Non-refundable, Warranty included, your own...) show on the product page and are saved on each order line.

## Reviews
On a product page customers tap "Write a review", enter name + email, rating and comment. The server accepts it only if that email has an order (paid, or any order while Paystack is not set up) that contains the product. One review per email per product (sending again updates it). Hide or delete reviews in admin > Reviews.

## Home screen layout
Search bar on top, tabs under it (For you + each main category), the banner, an Under #1000 strip (3 items, tap the label for the full under-1k shop), then a 2-column staggered feed of product cards (price, "N sold" from real paid orders, condition tag). The "For you" feed puts about 2 of every 3 items from what the shopper viewed, saved, added to cart or searched (kept in their own browser only), the rest are other products so the feed stays varied.

## Security notes
- Keep every secret in Render > Environment (ADMIN_PASSWORD, DATABASE_URL, PAYSTACK_SECRET_KEY, email keys). Never put them in a file on GitHub.
- Make the GitHub repository Private (Settings > General > Danger Zone > Change visibility). Render can still deploy a private repo.
- The public product API no longer exposes the supplier link or your cost price. Brand names (fashion, luxury, sports clubs) are removed automatically from names, descriptions and labels; edit BRAND_WORDS in server.js to change the list.
- Admin login locks an IP for 15 minutes after 5 wrong passwords. Use a long unique password (12+ characters).
- Public forms (orders, reviews, requests) are rate limited and size limited.

## Product requests and sold-out items
- Customers use "Request a product" (menu, search page, home page, footer) or "Notify me when it's back" on a sold-out product. Admin > Requests lists them with suggested matching products; tap "Email: it's listed" to tell the customer.
- Untick "In stock" on a product to show Sold out. Tick it again and every customer who asked about that exact product is emailed automatically.

## Policy pages
/returns-policy (no returns or refunds except items that arrive broken or seriously damaged), /terms and /privacy-policy are linked from the footer, checkout and emails. Edit the wording in server.js (search for "Returns & Refunds Policy").

## Air and sea shipping (latest)

- **Sea shipping** (free) takes 8 to 10 weeks. **Air shipping** takes 7 to 10 days and is charged by weight ($9/kg normal, $21/kg special and battery items, in naira at your dollar rate).
- **Air billing:** the whole cart is weighed together in kg and grams. Under 1 kg (including 0.50 kg and lighter) is billed as 1 kg. Above 1 kg the exact weight is billed. Example: two 0.4 kg items = 0.8 kg, billed as 1 kg. Two 0.7 kg items = 1.4 kg, billed as 1.4 kg.
- **Air on or off per product:** in the product form, untick "Air shipping available for this product". In admin > Products, tap UNDO AIR to switch it off or ADD AIR to switch it back on. If any item in a cart has air off, the customer only sees sea shipping for that order, and the server rejects air orders for it.
- **Search products in admin:** the Products tab has a search box (name, category or ID) and a filter (air off, air on, hidden, sold out).

## Accounts and the Free Gift (latest)

- **Accounts:** browsing, search, wishlist and the cart work without an account. Checkout needs one (email, phone, password; a 6-digit email code is required when email sending is set up). Orders are linked to the account.
- **Free gift flow:** first-time visitors see a pop-up (CLAIM NOW) and a floating gift button. The Gift Shop has a bar from N0 to N10,000 that fills as items are chosen (never above the limit). After CONTINUE the visitor shares a link; each friend who opens it and creates a verified account fills one of the 3 circles. At 3 the gift unlocks, and it is added free at checkout once the other items in the cart reach N20,000. One gift per account. Below N20,000 the visitor can still check out normally and keep the gift for later.
- **Admin > Free Gift tab:** switch the campaign on or off, set the value, friends needed and minimum purchase, upload or replace the pop-up image (shown with FREE GIFT text over it; a built-in gift drawing is used until you upload one), **upload a brand new gift item** (photos, value, colours, sizes, weight, air on/off) or **add an existing product** with one tap (its photos, colours, sizes and weight are copied, and you can change the gift value), edit or hide or delete gift items, and manage claims (approve flagged friends, unlock, reset, cancel, release).
- **Anti-abuse:** the same email or phone cannot count twice, nobody can refer themselves, and the 3rd signup from one internet connection within 24 hours waits for your approval in Free Gift > Claims.
- Gift items count in air-shipping weight and respect their air on/off switch. Prices and the gift rules are always checked again on the server.

## Fixes: admin photo upload, translation, banner

- Admin product form no longer lets the browser restore old values into the wrong boxes (autocomplete is off on all fields). The half-filled product is saved as a draft while you type and restored by the page itself after a reload. If the phone reloads the page while the photo picker is open, the page tells you to pick the photos again.
- The Translate button never writes the translator's error text ("PLEASE SELECT TWO DISTINCT LANGUAGES") into the name or description. English text stays as it is.
- The home banner grows with its text, so the Shop Now button and dots are never cut off on narrow phones.
