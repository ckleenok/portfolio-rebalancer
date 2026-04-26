# Portfolio Rebalancer

Portfolio rebalancing planner for GLD, SCHD, SPY, and QQQ.

## Run locally

```powershell
npm start
```

Open `http://localhost:4173`.

## Temporary public URL

With the local server running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start_tunnel.ps1
Get-Content .\tunnel.out
```

The tunnel stays online while this PC and the local server are running.

## Deploy on Render

1. Create a GitHub repository and push this folder.
2. In Render, choose **New Web Service**.
3. Connect the repository.
4. Use:
   - Build command: `npm install`
   - Start command: `npm start`
5. Deploy.

The app uses `PORT` from the hosting environment automatically.

## Deploy on Vercel

This project is ready for Vercel:

- Static files are served from `public/`.
- `/api/sheet` and `/api/history` are implemented as Vercel Serverless Functions.

Recommended flow:

1. Create a new GitHub repository named `portfolio-rebalancer`.
2. Push this folder to `ckleenok/portfolio-rebalancer`.
3. In Vercel, choose **Add New Project**.
4. Import `ckleenok/portfolio-rebalancer`.
5. Keep the default build settings and deploy.
