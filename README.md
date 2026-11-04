# Nova AI — Full-stack starter

Chat UI with a Google Gemini API connection through a Node.js backend.

## Deploy
- Runtime: Node.js 20+
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `GEMINI_API_KEY` (set privately in your host dashboard)

Never commit a real `.env` file or expose the API key in browser code.

## Local setup
1. Run `npm install`
2. Copy `.env.example` to `.env` and add your Gemini API key.
3. Run `npm start`
4. Open http://localhost:3000

This starter needs authentication, persistence, quotas and abuse monitoring before broad public use.
