# GhosterDex on NEAR

GhosterDex is a self-custody wallet on [Telegram](https://t.me/GhosterdexBot?startapp), [Android](https://ghosterdex.com/download) and [the web](https://ghosterdex.com). Its private balance is a NEAR Intents account, and what the vault swaps, buys or funds moves from there. Its Private AI runs on NEAR AI Cloud.

**Built at NEAR HACKATHON:** people and their AI agents can use private AI and pay for it from a private balance, with no card and no borrowed key. An agent can buy its own credit, make its own API key and think with it.

GhosterDex is an existing product. It has used NEAR Intents since its first version, and its keys and its public wallet are on TON, which the app calls the Gram chain. The entry is what was built since the hackathon's announcement, listed in [What was built in the window](#what-was-built-in-the-window). Everything older is [listed as baseline](#what-it-is-built-on).

## The problem

Using AI and spending money both leave a trail. Chat services keep what you ask. A public wallet shows what you hold and everything you pay for. An AI agent that needs to pay for its own compute usually has to borrow its owner's card or API key.

GhosterDex answers with one private balance that pays for all of it, and a choice of models that run in secure hardware, in a wallet people can already use.

## Try it with no account and no money

You need Node.js 22.6 or newer.

```bash
git clone https://github.com/zunem001/ghosterdex-near.git
cd ghosterdex-near
npm ci
```

| Do | See |
|---|---|
| `npm test` | 23 tests pass: how NEAR AI's catalogue is read and charged, which purse pays for credit, and where a payment lands. |
| `npm run demo:attestation` | `ALL CHECKS PASSED`. With a nonce you make and no key, it verifies GLM 5.3 Flash's Intel TDX quote locally against Intel's collateral, and asks NVIDIA's attestation service about the GPU evidence in the report. The script says what this does not prove. |
| `npm run demo:attestation -- --tamper` | `FAIL`, once. The real quote passes, then the same quote with one byte changed is refused. |
| `npm run demo:models` | NEAR AI's live catalogue as the app reads it: the models in NEAR AI's own secure hardware, those on a partner's, and those that are not private. |
| `npm run demo:wallet` | The live wallet's connector: its 8 read-only tools, a real price for 1 NEAR in USDT, Earn rates, and network status. Nothing moves. |
| `npm run build:kit`, then `npm run verify:kit` | `SAME BYTES`. The agent kit built from this source is, byte for byte, the file `ghosterdex.com` gives to agents. |

## Try it in the app, free

1. Install the Android app from [ghosterdex.com/download](https://ghosterdex.com/download), tap **Create or restore wallet**, and follow the steps to **Create a new wallet**. If Home says the balance is unavailable, close the app fully, swipe it away, and reopen it once. See a zero balance.
2. Open **Explore**, then **Private AI**. See GLM 5.3 Flash selected, labelled Private and Free.
3. Ask anything. See an answer, with nothing taken from your balance. People get 50 free questions a day, while the day's shared free budget lasts.
4. Open the model list. NEAR AI's secure-hardware models come first, those on a partner's hardware say Partner, and the rest are folded under More models, tagged Not private.

## Try it as an agent

The kit is one file and needs nothing installed:

```bash
curl -fsSL https://ghosterdex.com/agent/gdx.mjs -o gdx.mjs
node gdx.mjs init --name "Judge"
node gdx.mjs ai_models
node gdx.mjs ai_ask "What is NEAR Intents?"
```

`init` makes a wallet on your machine, registers it with GhosterDex, and prints its check code. `ai_models` lists every model it can use, private ones first, with where each runs and its price. `ai_ask` answers that the agent has no credit yet, because agents pay their own way.

To go further, run `node gdx.mjs deposit_address USDC base` and send at least $2 of USDC on Base to the address it prints, only that coin on that network. Then run `node gdx.mjs ai_add_credit 1`, and ask again. `node gdx.mjs ai_usage` shows what that question cost, to the micro-dollar.

The kit also runs as an MCP server, with `node gdx.mjs mcp`.

## What was built in the window

The hackathon counts code written since its announcement on 2026-10-19. **[The diff from `pre-hackathon` to `hackathon-submission`](https://github.com/zunem001/ghosterdex-near/compare/pre-hackathon...hackathon-submission)** is that work, for the code in this repository.

| Date | What | Where |
|---|---|---|
| Oct 20 | NEAR AI Cloud in Private AI, the first network to answer anyone: the live catalogue, three privacy tiers, routing, NEAR AI's own per-token prices, and credit from $1 | `worker/nearai.ts`, `worker/aimodels.ts`, `worker/privateai.ts` |
| Oct 22 | Agents use Private AI and pay for it themselves: buy credit from their own vault, ask, make and revoke API keys | `agent/kit/ai.ts`, `test/pay-with.test.ts` |
| Oct 22 | An agent can think with Private AI's API: tools (function calling), long conversations and streamed tool calls, from any framework that speaks chat completions | `worker/aiapi.ts` |
| Oct 22 | GLM 5.3 Flash is free in the app's chat for people | `worker/privateai.ts` |
| Oct 22 | A vault payment can land in Tether on NEAR when 1Click has the route to the Gram chain paused. Credit and Trade Factory passes keep working. Gifts, Stars and Premium keep working as far as the fulfilment float covers them, and past it the order is refused before anything is signed | `worker-excerpts/box-landing.ts`, `test/landing.test.ts` |
| Oct 24 | Usage history: each request's model, tokens, cache and cost, by account, key and agent, never its content | `worker/ailedger.ts`, `worker/aiapi.ts`, `agent/kit/ai.ts` |
| Oct 24 | Cash: naira and shillings in and out of the vault, through a partner's hosted widget. Not open to everyone yet | Closed source |
| Oct 30 | Four more NEAR AI models, each measured first | `worker/nearai.ts` |
| Oct 30 | BTC on Bitcoin under its new asset id | `worker/moved.ts` |
| Nov 3 | Two NEAR AI models with their refusals removed, on a person's API key only, under a warning | `worker/nearai.ts` |
| Nov 3 | AI scan: a private NEAR AI model checks a site or transaction in the Android browser, paid from credit | Closed source. [See the map](docs/near-map.md#the-browsers-ai-scan) |
| Nov 4 | An attestation check for anyone to run, with these tests and demos | `demo/`, `test/` |
| Nov 5 | Kit 1.9.1, and how Private AI counts usage | `agent/kit/`, `worker/ailedger.ts`, `worker/privateai.ts` |

## What it is built on

**This is existing work, not part of the hackathon entry.** It is at the `pre-hackathon` tag or in the closed-source app:

- The wallet, the private vault, swaps, private sends, deposits and withdrawals
- Telegram Stars, Premium and gifts
- Perps on Hyperliquid and Aster, limit orders, Earn, NEAR staking, tokenized stocks
- Agent Wallets and the kit, up to version 1.7
- Private AI's screen, API keys and credit ledger, deployed for the owner alone and answering nothing until NEAR AI
- Trade Factory and the read-only connector

**[docs/near-map.md](docs/near-map.md) shows how each of these uses NEAR, route by route.**

The tag can be checked against what was served. `pre-hackathon` builds to the same bytes as [gdx-1.7.0.mjs](https://ghosterdex.com/agent/gdx-1.7.0.mjs):

```bash
git worktree add ../baseline pre-hackathon && cd ../baseline && npm ci && npm run build:kit
sha256sum public/agent/gdx.mjs
curl -fsSL https://ghosterdex.com/agent/gdx-1.7.0.mjs | sha256sum
```

## NEAR technology used

| Technology | What GhosterDex does with it |
|---|---|
| **NEAR Intents** (`intents.near`) | Every private balance is an account on it, controlled by the wallet's own key. |
| **Confidential Intents** | Deposits, swaps, sends, withdrawals and purchases run with `confidentiality: advanced`. |
| **1Click API** | Quotes, deposit addresses, `generate-intent`, `submit-intent`, status, balances, limit orders. |
| **NEAR AI Cloud** | Private AI's models, read from its catalogue and sorted into tiers by `verifiable` and `providerType`. `demo:attestation` reads its attestation reports; the app does not yet. |
| **Tether on NEAR** (`usdt.tether-token.near`) | Where a vault payment can land when the usual route is paused. |
| **stNEAR** (Meta Pool) | NEAR staking in Earn, through the public Intents balance. |

**Not used:** Chain Signatures, meta transactions, sub-accounts, or a NEAR contract of our own. GhosterDex builds on `intents.near` rather than deploying contracts.

## What is in this repository

GhosterDex's app and worker are closed source, so this is a public extract:

- `agent/` and `src/perps/`: the whole agent kit, in the same layout as the private repository.
- `worker/` and `src/lib/`: Private AI and its NEAR AI code. The router that serves them, `worker/index.ts`, is closed, so they are for reading and for the tests.
- `worker-excerpts/`: functions copied word for word from the closed worker, each marked as an excerpt.
- `demo/`, `test/`: everything in the tables above.

The last commit is new. Every commit before it replays the private repository's commits for these paths, keeping their original dates, with new, shorter messages. A few comments read differently here in every version: long dashes became commas, a local file path is gone, and some are shorter. The code is the same.

The wallet's browser code is public where it is served: for example [fund-pro.js](https://ghosterdex.com/fund-pro.js), which funds perps.

## Limits

- **Private means hidden from the public.** GhosterDex's server relays quotes, keeps an activity ledger, and once your wallet signs the balance link it holds a sealed session that reads your private balance. It sees your routes and what you hold, and 1Click does too. It holds no key that can sign for your balance.
- **Questions pass through our server.** It forwards each one to NEAR AI and could read it in transit. Its code does not log or store it. Models marked Not private run at their makers.
- **A perps position is public** on the venue. What the private route from the vault hides is the link from the wallet to the trading address.
- **The Gram wallet is public.** Buying from it is an ordinary on-chain payment and does not use NEAR. Funding perps from it uses NEAR Intents' public road, in the open.
- **Stars, Premium and gifts** are bought by GhosterDex's own fulfilment service after your payment lands, from Fragment and, for gifts, through Thermos, so that step relies on us and on them. A gift's receiver must have written "Hi" to @thermos_vault in the last day and accept unique gifts. An order that cannot be bought is refunded.
- **Where a model runs** is read from NEAR AI's catalogue. The app does not yet check attestation or response signatures itself. `demo:attestation` shows the hardware check anyone can run today for a `tee` model, and says what it does not prove.

## Libraries and tools

Own earlier code is baseline, as above. Third-party libraries in this repository: `@ton/core`, `@ton/crypto`, `@ton/ton`, `@noble/hashes`, `@noble/secp256k1`, `tweetnacl`, `esbuild`, `tsx`, `typescript`, `@phala/dcap-qvl`. In the closed app and worker, among others: `@tonconnect/ui-react`, `react`, `bs58`, `lottie-web`, `qrcode.react`, `@affluent-org/sdk`. This project is built with AI coding tools, Claude Code among them.

## License

[MIT](LICENSE)
