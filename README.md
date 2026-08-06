# AlVik — Personal AI Chat

**AlVik** is a fast, fully-equipped, single-file AI chat client
(`index.html`) backed by a Cloudflare Worker proxy to the DeepSeek API. No
build step, no framework, no server of your own — open the file or host it
on any static host (GitHub Pages, Cloudflare Pages, Netlify).

**Live (GitHub Pages):** https://bikram2051.github.io/AlVik/ — deployed
automatically by `.github/workflows/pages.yml` on every push to `main`.
(The path is case-sensitive: it matches the repository name.)

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
- **Recently deleted** — deleting a chat is undoable. Deleted conversations go
  to a trash that keeps them for 30 days: hit **Undo** on the toast, or
  restore them later from Settings → Recently deleted. "Delete all
  conversations" is undoable the same way. Backups include the trash.
- Everything is stored locally in your browser (`localStorage`) — nothing is
  saved server-side

> **Storage is per-origin.** `localStorage` is scoped to the exact origin
> serving the page, so chats saved on one URL are not visible from another
> (`bikram2051.github.io` vs. a Cloudflare Pages URL vs. a local `file://`
> copy are three separate stores). The data is not lost — it is still under
> the old origin. To move it, open the old URL, **Settings → Backup all
> (.json)**, then **Import backup** on the new one.

## Architecture

```
┌────────────┐  POST /api/login {password}   ┌────────────────────┐
│            │ ◀── signed session token ──── │                    │
│ index.html │                               │ Cloudflare Worker  │   ┌──────────────┐
│  (Pages)   │  POST /api/chat               │  APP_PASSWORD      │──▶│ DeepSeek API │
│            │ ─ Bearer <token> ───────────▶ │  AUTH_SECRET       │◀──│              │
│            │ ◀─ SSE stream or JSON ─────── │  DEEPSEEK_API_KEY  │   └──────────────┘
└────────────┘                               └────────────────────┘
```

Every secret lives in the Worker. The browser holds only a signed, expiring
session token — never the password, never the API key.

## Setup

### 1. Deploy the Worker (`worker/`)

```bash
cd worker
npx wrangler secret put DEEPSEEK_API_KEY   # your DeepSeek API key
npx wrangler secret put APP_PASSWORD       # the password you'll type to log in
npx wrangler secret put AUTH_SECRET        # 32+ random chars, signs tokens
npx wrangler deploy
```

`wrangler secret put` **prompts for the value on stdin** — do not pass the
secret as an argument, or it lands in your shell history. To script it,
pipe instead:

```bash
printf '%s' "$MY_SECRET" | npx wrangler secret put AUTH_SECRET
```

Generate a good `AUTH_SECRET` with:

```bash
openssl rand -base64 48
```

### Models

| Model | Notes |
| --- | --- |
| `deepseek-v4-pro` | Default. Sent with `reasoning_effort: high` and thinking mode enabled. |
| `deepseek-reasoner` | Also gets thinking mode. |
| `deepseek-chat` | Plain chat, no reasoning parameters. |

The Worker only forwards models on this allow-list; anything else falls
back to the default. Pick one in **Settings → Model**. If a model rejects a
streaming request, the Worker retries once without streaming rather than
failing the message.

`ALLOWED_ORIGINS` is set in `wrangler.toml` and should list exactly the
origins allowed to call the proxy.

Verify the deploy:

```bash
curl https://deepseekv4pro.vikrambhattarai1994.workers.dev/api/health   # -> {"ok":true,...}
```

### 2. Point the client at your Worker

One line at the top of the `<script>` block in `index.html`:

```js
const PROXY_URL = 'https://deepseekv4pro.vikrambhattarai1994.workers.dev';
```

There is no password in the client — do not add one back. The deploy
workflow fails the build if a `PASSWORD` constant or an API key reappears in
`index.html`.

### 3. Host it

GitHub Pages serves `index.html` straight from the `main` branch — set it
once under **Settings → Pages → Deploy from a branch → `main` / root**.
Every push to `main` republishes automatically.

`.github/workflows/ci.yml` runs on each push and **fails the build if a
password constant or an API key ever reappears in `index.html`**, so the
old client-side-secret mistake cannot ship again.

## Security model

| Concern | How it's handled |
| --- | --- |
| DeepSeek API key | Worker secret. Never sent to the browser. |
| App password | Worker secret, compared in constant time. Never in the client or in git. |
| Session | HMAC-SHA256 token signed by the Worker, 30-day expiry, verified on every chat request. |
| Stolen/forged token | Rejected — signature and expiry are both checked server-side. |
| Other sites using your proxy | Blocked by `ALLOWED_ORIGINS` (CORS). |
| Password guessing | Per-IP rate limit on `/api/login` (best-effort) — use a strong password. |

**To revoke every session immediately** (lost device, shared password),
rotate the signing secret — all existing tokens stop working at once:

```bash
npx wrangler secret put AUTH_SECRET
```

## Development

There is intentionally no build step. Edit `index.html`, refresh the browser.
External libraries (marked, highlight.js, DOMPurify, and lazily: KaTeX,
pdf.js, mammoth, SheetJS) load from CDNs.
