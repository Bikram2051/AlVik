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

### 1. Deploy the Worker

Run these from the **repository root** — `wrangler.toml` lives there and
points at `worker/worker.js`:

```bash
npx wrangler secret put APP_PASSWORD       # the password you'll type to log in
npx wrangler secret put AUTH_SECRET        # 32+ random chars, signs tokens
npx wrangler secret put DEEPSEEK_API_KEY   # DeepSeek provider key
npx wrangler secret put OPENAI_API_KEY     # optional, for OpenAI models
npx wrangler deploy
```

No Node installed? Set the secrets under **Workers & Pages → your Worker →
Settings → Variables and Secrets** (type **Secret**), and paste
`worker/worker.js` into **Edit Code → Deploy**.

**Automatic deploys (Cloudflare Workers Builds).** Connect the repo and
leave the root directory as `/`. The config at the root is what makes this
work: without it wrangler falls back to interactive setup, decides the
whole repository is a static-assets directory, and fails trying to upload
`node_modules` (its own `workerd` binary is over the 25 MiB asset limit).
There is deliberately no `[assets]` block — this deploys a Worker script
only; the web client is served by GitHub Pages.

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

### Models and providers

Pick a model in **Settings → Model**. Models are grouped by provider, and
any whose provider key isn't set shows as unavailable instead of failing
when you send.

**Built in:**

| Model | Provider | Thinking levels |
| --- | --- | --- |
| `deepseek-v4-pro` | DeepSeek | low / medium / high (default: high) |
| `deepseek-reasoner` | DeepSeek | low / medium / high (default: high) |
| `deepseek-chat` | DeepSeek | — |

**Any other model:** choose **Custom model ID…**, pick the provider, and
enter the exact id from that provider's API docs. Marketing names ("GPT
5.6", "Ultra") are usually not the API id — use the documented string.
Nothing in the Worker needs changing for a model that shipped today.

**Thinking level** appears only for models that accept one. *Default for
this model* omits the parameter and lets the provider decide.

**Adding a provider** takes one entry in `PROVIDERS` in `worker/worker.js`
plus its key as a Worker secret. Adding a model to the built-in list is one
entry in `MODELS`. Both are plain data:

```js
const PROVIDERS = {
  openai: { url: '…/chat/completions', keyEnv: 'OPENAI_API_KEY', label: 'OpenAI' }
};
```

Providers disagree on details that cause hard-to-read 400s, so each model
declares them rather than the code guessing: which thinking tiers it
accepts, whether the token cap is `max_tokens` or `max_completion_tokens`,
and whether a custom `temperature` is allowed.

Only the providers you configure are usable — a missing key is reported
per-model, never a Worker-wide failure. If a model rejects a streaming
request, the Worker retries once without streaming instead of erroring.

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
