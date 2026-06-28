# QunatLab Project Notes

Last updated: 2026-06-28

## Purpose

QunatLab is a Korean market dashboard for checking domestic indices, key Korean stocks, overseas reference indices, KOSPI 200 night futures, exchange-rate context, market session status, compact charts, and market news in one screen.

## Repository

- GitHub: `zerojin91/market-source-dashboard`
- Local path: `C:\Users\user\Documents\QunatLab\market-source-dashboard`
- Main branch: `main`
- Latest pushed commit at this checkpoint: `28bb2c3 Polish QunatLab dashboard UI`
- Deployment flow: push to GitHub `main`; Vercel Git integration should auto-deploy.

## Runtime Structure

- Local server: `node server/index.js`
- Local URL: `http://localhost:3000/`
- Vercel API entry: `api/quotes.js`
- Shared data logic: `server/index.js`
- Frontend files:
  - `public/index.html`
  - `public/styles.css`
  - `public/app.js`

`api/quotes.js` imports `getQuotes()` from `server/index.js`, so local API behavior and Vercel API behavior share the same quote/news logic.

## Current Data Sources

- KOSPI LAB: `https://kospilab.com/`
  - Used for KOSPI LAB style reference, market text, domestic stock context, USD/KRW metadata when parseable.
- eSignal night futures: `https://esignal.co.kr/kospi200-futures-night/`
  - Page HTML and cache candidates are checked.
  - Frontend also attempts a socket connection to eSignal for real-time night futures updates.
- Naver Finance fallback:
  - `https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI,KOSDAQ`
- Yahoo Finance fallback:
  - NASDAQ: `https://query1.finance.yahoo.com/v8/finance/chart/%5EIXIC`
  - S&P 500: `https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC`
- SaveTicker news:
  - Site: `https://www.saveticker.com/news`
  - API base: `https://api.saveticker.com/api`
  - Top stories: `/news/top-stories`
  - Latest list: `/news/list?page=1&page_size=8&sort=created_at_desc`

## Refresh and Cache Policy

- Main dashboard polling interval: 10 seconds.
- Quote history is stored client-side in `localStorage` under `qunatlab.quoteHistory.v1`.
- Quote history retention: 7 days.
- Chart visible x-axis: today 00:00 to 23:59.
- Chart baseline: first recorded price for the current day.
- SaveTicker news server cache: 5 minutes.
  - This avoids calling SaveTicker every 10 seconds.
  - If refresh fails and a previous successful news payload exists, stale cached news is returned.

## Current UI Decisions

- App name is intentionally spelled `QunatLab`.
- Layout is inspired by KOSPI LAB and the ChatGPT Codex landing visual language:
  - light background
  - soft blue/purple highlight
  - compact top status pills
  - white rounded cards
- Header includes:
  - overseas estimated real-time price status
  - Korean market open/closed status and countdown
  - centered QunatLab title
  - USD/KRW pill
  - local clock/update indicator
- News section sits between source tabs and the indices section.
  - Top stories tab: 3 items
  - Latest news tab: 6 items
  - News text is sanitized to avoid `[object Object]`.
  - News thumbnails have fixed height to avoid oversized cards.
- Quote cards include compact SVG sparklines.
  - Neutral line color only.
  - No end-point dot.
  - Dashed baseline for first recorded daily price.

## Verification Performed

- `node --check public/app.js`
- `node --check server/index.js`
- Browser checks on `http://localhost:3000/`
  - news cards rendered
  - news tab switching works
  - no `[object Object]` news text
  - no console errors during prior checks
- GitHub push completed:
  - `main -> origin/main`
  - commit `28bb2c3`

## Important Caveats

- Data parsing relies on third-party public pages/APIs, so selectors/text patterns may break if those sites change.
- SaveTicker API is third-party. Keep the 5-minute server cache or longer to avoid excessive traffic.
- In local development, outbound third-party requests originate from the local machine/network. On Vercel, they originate from Vercel infrastructure, not each dashboard visitor directly.
- Vercel CLI was not locally installed. `npx vercel@latest` worked for version check, but direct deploy stalled because the project was not linked with `.vercel/project.json`.
- Current deployment method is GitHub push and Vercel Git integration.

## Suggested Next Tasks

- Confirm the Vercel production deployment for commit `28bb2c3`.
- Add a visible small cache/update state for news if desired.
- Improve chart persistence beyond browser-local storage if multi-device history is needed.
- Consider a first-party storage/cache layer if traffic grows.
- Add lightweight automated checks for `/api/quotes` response shape.
- Review source terms/rate limits before public release or heavy sharing.
