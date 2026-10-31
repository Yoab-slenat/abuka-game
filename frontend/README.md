# Number Matching Game — shared backend version

This project contains a green responsive frontend and a Node.js/Express + PostgreSQL backend. The server, not the browser, controls registration capacity, number uniqueness, countdown, and private match results.

## Game rules implemented
- 5 players maximum in Group A and 5 in Group B (10 total).
- Player IDs are unique within a round.
- Each group can use each number from 1 to 10 only once.
- When all 10 players have selected, the server starts a 10-second countdown.
- After the countdown, a player can see only their own opposite-group partner, if there is one.
- Both matched players receive the same pair information: full name and Telegram username.
- Admin can see all registered players and numbers and can reset the round.

## 1. Run the backend locally

Install Node.js 20 or newer and create a PostgreSQL database. In a terminal:

```bash
cd backend
npm install
```

Copy `.env.example` to `.env` and fill in your real values. Never commit `.env` or share `DATABASE_URL`, `JWT_SECRET`, or the admin password hash.

Create a bcrypt hash for your chosen admin password:

```bash
node -e "require('bcryptjs').hash('CHOOSE_A_STRONG_PASSWORD', 12).then(console.log)"
```

Put the resulting hash in `ADMIN_PASSWORD_HASH`. Set `ADMIN_USERNAME`, `JWT_SECRET` (at least 32 random characters), `DATABASE_URL`, `DATABASE_SSL`, and `FRONTEND_ORIGIN`.

Start the API:

```bash
npm start
```

Health check: `http://localhost:10000/api/health`

## 2. Connect the frontend locally

Serve the project root with a local static server (for example, VS Code Live Server). Edit `config.js`:

```js
window.API_BASE_URL = 'http://localhost:10000';
```

Set `FRONTEND_ORIGIN` in backend `.env` to the exact local frontend origin shown by your browser, for example `http://127.0.0.1:5500` or `http://localhost:5500`. These origins are not interchangeable; use the exact one.

## 3. Deploy to Render

1. Create a PostgreSQL database on Render.
2. Create a Web Service from your GitHub repository.
3. Set **Root Directory** to `backend`.
4. Build Command: `npm install`.
5. Start Command: `npm start`.
6. Add the environment variables from `.env.example` in the Render service settings. Use the database's **Internal Database URL** when the backend is hosted in the same Render region/network, and set `DATABASE_SSL=false` for Render's internal connection if Render's current database instructions specify that. If using an external URL requiring TLS, set `DATABASE_SSL=true`.
7. Set `FRONTEND_ORIGIN` to the exact deployed frontend URL (no trailing slash).
8. Deploy and test `https://YOUR-BACKEND.onrender.com/api/health`.
9. Edit the root `config.js` and set `window.API_BASE_URL` to `https://YOUR-BACKEND.onrender.com` (no trailing slash), then redeploy the frontend.

Do not put database credentials, JWT secrets, or admin passwords in `config.js` or frontend code.

## 4. Important deployment checks

- The frontend must call the backend URL in `config.js`; a relative `/api/...` URL will not work when frontend and backend are separate services.
- CORS must allow the exact frontend origin.
- Both services must be online and use the same PostgreSQL database.
- Test with two separate browsers/devices: register one player in each group, continue until 5 in each group, submit distinct numbers within each group, then verify the countdown and each player's private result.
- The number pool is 1–10, matching the selection UI. The decorative home-page tiles are not the rules.
- This starter uses browser localStorage for the opaque player session token. It is not a substitute for protecting the device; log out on shared devices. For a higher-security production deployment, serve frontend and API from one origin and use secure HttpOnly cookies.
