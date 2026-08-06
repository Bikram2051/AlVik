# AlVik — Personal AI Chat

**AlVik** is a fast, fully-equipped, single-file AI chat client
(`index.html`) backed by a Cloudflare Worker proxy to the DeepSeek API. No
build step, no framework, no server of your own — open the file or host it
on any static host (GitHub Pages, Cloudflare Pages, Netlify).

**Live (GitHub Pages):** https://bikram2051.github.io/My_Assistant/ —
deployed automatically by `.github/workflows/pages.yml` on every push.

## Features

**Conversation**
- Streaming responses (SSE) with live rendering, plus automatic fallback to
  plain JSON when the proxy doesn't stream
- Collapsible "Thinking" blocks for reasoning models (DeepSeek Reasoner /
  `<think>` output)
- Multiple conversations with pinning, search, rename, and date grouping
  (Today / Yesterday / Previous 7 days / …)
- Edit any of your messages in place and regenerate from that point
- Retry, copy, read-aloud (text-to-speech), and delete on any message
- Per-response stats: model, elapsed time, approximate tokens, tokens/sec

**Input**
- File attachments with client-side text extraction: PDF, DOCX, XLSX, and
  ~40 text/code formats (drag-and-drop, paste, or picker)
- Voice dictation (Web Speech API, shown only when the browser supports it)
- Character counter, keyboard shortcuts (⌘K new chat, ⌘/ focus, ⌘\ sidebar)

**Reliability & safety**
- Automatic retry with exponential backoff on network errors, 429s and 5xxs
- Request and mid-stream stall timeouts; Stop button keeps partial output
- Context-window management — long histories are trimmed to a budget before
  sending
- All model output sanitized with DOMPurify before rendering
- Offline detection banner; storage-quota warnings

**Rendering**
- Markdown + GFM, syntax-highlighted code blocks with copy buttons
- LaTeX math via KaTeX (lazy-loaded only when a message contains math)
- Light/dark theme, mobile responsive, reduced-motion support

**Model controls (Settings)**
- Model picker (DeepSeek Chat / DeepSeek Reasoner / custom ID)
- Temperature, max response tokens, streaming toggle
- Custom system prompt + persistent "writing style memory"

**Data**
- Export the current chat as Markdown
- Full JSON backup of every conversation, and import on any device
- Everything is stored locally in your browser (`localStorage`) — nothing is
  saved server-side

## Architecture

```
┌────────────┐  POST {messages, model,   ┌────────────────────┐   ┌──────────────┐
│ index.html │ ─ temperature, stream …─▶ │ Cloudflare Worker  │──▶│ DeepSeek API │
│ (any host) │ ◀─ SSE stream or JSON ─── │ (holds the API key)│◀──│              │
└────────────┘                           └────────────────────┘   └──────────────┘
```

The browser never sees the DeepSeek API key — it only talks to the Worker.

## Setup

### 1. Deploy the Worker (`worker/`)

```bash
cd worker
npx wrangler secret put DEEPSEEK_API_KEY   # paste your DeepSeek key
npx wrangler deploy
```

The worker supports both streaming and non-streaming requests and keeps the
legacy `{ reply }` response shape, so an already-deployed older worker keeps
working too (the UI just falls back to non-streaming automatically).

Optionally set `ALLOWED_ORIGINS` in `wrangler.toml` to lock the proxy to your
site's origin.

### 2. Configure the client

At the top of the `<script>` block in `index.html`:

```js
const PROXY_URL = 'https://your-worker.your-subdomain.workers.dev';
const PASSWORD  = '...';
```

### 3. Host it

Any static host works — GitHub Pages, Cloudflare Pages, Netlify — or just
open `index.html` locally.

## Security note

The password gate is a **client-side convenience lock**, not real
authentication: anyone who reads the page source can see it. It keeps casual
visitors out of your UI, but the thing that actually needs protecting — the
API key — lives only in the Worker. For stronger protection, add a shared
secret header check in the Worker and lock `ALLOWED_ORIGINS` down.

## Development

There is intentionally no build step. Edit `index.html`, refresh the browser.
External libraries (marked, highlight.js, DOMPurify, and lazily: KaTeX,
pdf.js, mammoth, SheetJS) load from CDNs.
