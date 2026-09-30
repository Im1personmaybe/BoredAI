# Insanity AI on Render

This project serves the modified BoredAF page and proxies chat requests through a private Render server. The OpenRouter key is never sent to the browser.

## Deploy with Render

1. Create a new GitHub repository and upload the contents of this folder.
2. In Render, choose **New > Web Service** and connect the repository.
3. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free
4. Add an environment variable named `OPENROUTER_API_KEY` with a **new** OpenRouter key.
5. Add `PUBLIC_URL` with the final Render URL, such as `https://your-service.onrender.com`.
6. Deploy and open the Render URL.

The page's Insanity AI Chat card calls `/api/chat`. The server forwards requests to OpenRouter using the `openrouter/free` router, so users do not enter or see the key.

## Important security notes

- Do not put the API key in `index.html`, JavaScript, GitHub, or a downloadable file.
- Rotate any key that has been posted publicly.
- OpenRouter free models still have rate limits. The included server limits each IP to 20 chat requests per minute; add provider-side spend limits as well.
- The free Render service may sleep when idle, so the first request after inactivity can be slow.
