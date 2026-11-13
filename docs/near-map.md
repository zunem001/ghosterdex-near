# How GhosterDex uses NEAR

Every feature of the wallet that touches a NEAR product, and how. Features marked **New** were built in the hackathon window. Everything else is existing work. See the [README](../README.md).

Names in `code` are real: contract and asset ids, API fields, and kit commands. Where a file is named, it is in this repository unless it is marked closed source or served.

- [The foundation: one key, one NEAR Intents account](#the-foundation-one-key-one-near-intents-account)
- [Money in, around and out](#money-in-around-and-out)
- [Telegram Stars, Premium and gifts](#telegram-stars-premium-and-gifts)
- [Perps](#perps)
- [Earn, stocks and limit orders](#earn-stocks-and-limit-orders)
- [Private AI](#private-ai)
- [Agent Wallets](#agent-wallets)
- [The browser's AI scan](#the-browsers-ai-scan)
- [Other doors](#other-doors)

## The foundation: one key, one NEAR Intents account

A GhosterDex account is one ed25519 key. On Android it is made and kept on the phone. In Telegram and on the web it belongs to the wallet you connect with TON Connect. An agent makes its own on its own machine.

That key is also the owner of a **Confidential Intents account on `intents.near`**. It is the same account near.com derives for that wallet, so the money is not locked to GhosterDex. The account needs no NEAR account of its own and no NEAR for gas, because NEAR Intents accepts the wallet's TON Connect signature directly (`standard: 'ton_connect'`).

Every move out of a balance follows the same five steps ([worker-excerpts/signing.ts](../worker-excerpts/signing.ts)). A `deposit` or `bridge` route has only steps 1 and 5, because the money is sent on chain from outside.

1. **Quote.** `POST /v0/quote` on the 1Click API, with `confidentiality: 'advanced'` on the private routes. The answer holds a price and a `depositAddress`.
2. **Text to sign.** `POST /v0/generate-intent` with `type: 'swap_transfer'`, that `depositAddress`, the signer and `standard: 'ton_connect'`.
3. **Signature.** The wallet signs that text on the device as TON Connect `signData`.
4. **Submit.** `POST /v0/submit-intent`. The worker holds no key for any person's account. `/api/execute` first verifies that the signature belongs to the account's wallet and names this route (closed source), then forwards it through `submitIntent`.
5. **Follow.** `GET /v0/status?depositAddress=...` until the route settles.

What differs between features is only the shape of the route:

| Route | From, to | Used by |
|---|---|---|
| `deposit` | `ORIGIN_CHAIN` to `CONFIDENTIAL_INTENTS` | Money coming in from any chain; perps money coming home |
| `swap` | `CONFIDENTIAL_INTENTS` to `CONFIDENTIAL_INTENTS` | Swaps, stocks, Earn |
| `send` | `CONFIDENTIAL_INTENTS` to `CONFIDENTIAL_INTENTS`, another account | Private sends |
| `withdraw` | `CONFIDENTIAL_INTENTS` to `DESTINATION_CHAIN` | Withdrawals; funding perps from the vault |
| `boxpay` | `CONFIDENTIAL_INTENTS` to `CONFIDENTIAL_INTENTS`, the fulfilment account | Stars, Premium, gifts, Private AI credit, Trade Factory passes |
| `unshield` | `CONFIDENTIAL_INTENTS` to `INTENTS` | The first step of NEAR staking |
| `pubswap` | `INTENTS` to `INTENTS` | NEAR to stNEAR and back |
| `sweep` | `INTENTS` to `CONFIDENTIAL_INTENTS` | Moving a public balance into the vault |
| `bridge` | `ORIGIN_CHAIN` to `DESTINATION_CHAIN` | Funding perps from the Gram wallet, in public |

**Reading a balance.** A private balance cannot be read from the contract. The worker reads it from `GET /v0/account/balances` with the session token as `Authorization: Bearer`, from a session the wallet signs for at `POST /v0/auth/authenticate` and the worker keeps sealed. The public side of an account is read with `mt_batch_balance_of` on `intents.near`.

**Coins.** The list comes from `GET /v0/tokens?ondoTokens=true`, curated to 64 coins on 36 networks as of 2026-11-04. 1Click issues the deposit address for any chain it lists. When an asset moves to a new id, as BTC did to its `1cs_v1` id (picked up here on 2026-10-30, **New**), the old id is kept only so a holding can leave (`worker/moved.ts`).

## Money in, around and out

**Deposit.** Pick a coin and a network and get an address from a `deposit` route. Send from any wallet or exchange, and it lands private. A refund from a failed route, when no refund address was given, lands in the account's public `INTENTS` balance. Home shows that as a Public balance card with a Move to vault button, which is a `sweep` route. Kit: `deposit_address`.

**Swap.** Any listed coin to any other the vault can buy, across networks, in one signature. Solvers fill it through NEAR Intents. Kit: `quote`, `swap`. Connector: `quote`.

**Private send.** To another GhosterDex address, which is 64 hex characters, or a payment link. The recipient is credited as the route settles. Kit: `send`.

**Withdraw.** To any address on the coin's own network. Kit: `withdraw`.

## Telegram Stars, Premium and gifts

Open **Explore**, pick what to buy and who gets it, and choose how to pay in the **Pay with** sheet. It offers two purses:

- **The vault:** any listed coin, private, through NEAR Intents.
- **The Gram wallet:** public and direct. An ordinary on-chain payment with a memo that does not touch NEAR.

**Paying from the vault:**

1. The app places an order: `POST /api/stars/order`, `/api/premium/order` or `/api/gifts/order`. The order states the coin, the amount and where it lands.
2. `POST /api/quote` with `kind: 'boxpay'` builds a confidential route from your coin to the fulfilment account, and the order's status route then binds it to the order. Stars and Premium past what the float can front use a `withdraw` route to the service's on-chain wallet.
3. You sign, and the route runs like any other. The money lands in the fulfilment account's own private balance, so the payment does not put your wallet next to Telegram on a public chain.
4. GhosterDex's fulfilment service buys the item.
   - **Stars and Premium** come from Fragment, Telegram's own marketplace, paid from the service's own float once the payment settles. 50 to 10,000,000 Stars; 3, 6 or 12 months of Premium.
   - **Gifts** come from the marketplaces through Thermos, delivered to the buyer's or a friend's Telegram profile. The receiver must have written "Hi" to @thermos_vault in the last day and accept unique gifts. The listings are checked live, so sold gifts leave the grid.
5. An order that cannot be bought is refunded. If the route failed, the money stays in the vault. If it had landed, the refund usually comes as Gram on chain to your connected wallet, which is public.

**Where the money lands (New).** Normally Stars and Premium land as Gram, and gifts land as the Gram chain's Tether (`nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR`). If 1Click refuses that pair as paused, the order lands in **Tether on NEAR** (`nep141:usdt.tether-token.near`) instead, which has no bridge under it. It keeps working as far as the fulfilment float covers it. Past that, the order is refused before anything is signed, and the Gram wallet's direct road still works. A quote that merely flaked keeps the usual landing. See `boxLanding` in [worker-excerpts/box-landing.ts](../worker-excerpts/box-landing.ts), tested in [test/landing.test.ts](../test/landing.test.ts).

Agents can buy all three: `buy_stars`, `buy_premium`, `gifts`, `buy_gift`, `track_order`.

## Perps

**A perps position is public on the venue.** Money from the vault reaches the trading account by a confidential route, so the public side does not show which wallet funded it. In the app, a funding quote that does not report `confidentiality: 'advanced'` is not signed. The kit makes that check on the way back to the vault. Money from the Gram wallet takes a public road through the bridge, and the sheet marks it Public route.

On Android and in the kit, the trading key is derived from your recovery phrase on your device. In a browser it comes from a passkey, is made there and written down, or is paired from a phone. One address trades on both venues.

**Hyperliquid.**

- **In:** a single `withdraw` route from any listed vault coin to USDC on HyperCore (`1cs_v1:hypercore:erc20:0xb88339CB7199b77E23DB6E890353E22632Ba630f`), recipient the trading address. No gas and no second step.
- **Out:** a fresh `deposit` route into the vault gives an address, and the signed withdrawal pays that address directly. Hyperliquid keeps $1.
- **Code:** `agent/kit/hyperliquid.ts`, and [fund-pro.js](https://ghosterdex.com/fund-pro.js) (served) in the app.

**Aster.**

- **In:** `withdraw` routes send USDT, with a little BNB for gas when needed, to the trading address on BNB Chain, which then pays Aster's vault.
- **Out:** Aster pays the trading address, which sends the money on to a `deposit` route into the vault.
- **Code:** `agent/kit/aster.ts`.

Agents have the same commands: `perps`, `perps_markets`, `perps_deposit`, `perps_order`, `perps_close`, `perps_cancel`, `perps_withdraw`.

## Earn, stocks and limit orders

**Earn.** A start is a private swap into a receipt token, and a stop is the swap back. From $20. Yearly rates are live in the connector's `earn` tool.

| Product | By | Receipt |
|---|---|---|
| USDC Prime | Morpho | `gtUSDCp` |
| SOL Balanced | Kamino | `kV-gtSOLb` |
| USDC Optimizer | Taler | `TLO` |

**NEAR staking.** Solvers do not fill NEAR to stNEAR privately, so a stake is three routes and three approvals: `unshield` the NEAR to the public balance, `pubswap` it for stNEAR (Meta Pool), then `sweep` the stNEAR back into the vault. The app shows the public step for what it is. Unstaking is the same road the other way.

**Tokenized stocks.** Ondo's stocks and ETFs, listed by asking the catalogue with `?ondoTokens=true`, and held privately in the vault like any coin. Buys from $50, in New York market sessions, and not in every country. Kit: `stocks`, `swap`.

**Limit orders.** `POST /v0/orders` on 1Click, funded by the same `generate-intent` and signature as a swap. The order rests until it fills or expires, and what has not filled comes back to the vault. Kit: `limit_order`, `limit_orders`, `cancel_limit_order`.

## Private AI

**New: everything here on NEAR AI Cloud.** Private AI is a chat and an OpenAI-compatible API in the wallet, open to every verified account. It is answered today by NEAR AI Cloud. Cocoon is wired in but not connected. Its screen, API keys and credit ledger existed before the window, deployed for the owner alone and answering nothing. Code: [worker/nearai.ts](../worker/nearai.ts), [worker/aimodels.ts](../worker/aimodels.ts), [worker/privateai.ts](../worker/privateai.ts).

**Which models, and how private.** The app reads NEAR AI's public catalogue (`GET https://cloud-api.near.ai/v1/model/list`) and sorts each model by the catalogue's own fields (`parseCatalogue`):

| Tier | Rule | What the app shows |
|---|---|---|
| `tee` | `verifiable: true`, `providerType: 'vllm'` | Runs in NEAR AI's own secure hardware |
| `partner` | `verifiable: true`, any other provider | Runs in a partner's hardware that NEAR AI attests |
| `open` | Not verifiable | Folded behind More models, with a Not private tag |

Run `npm run demo:models` for today's list, and `npm run demo:attestation` to check a `tee` model's hardware yourself. NEAR AI reports partner models in another shape, which this script does not read. The list includes two models with their refusals removed. The chat and the kit do not offer them. They open only on a person's API key, under a warning.

**What a question costs.** Prices are NEAR AI's own, per million tokens, with no margin. A charge is counted in micro-dollars and rounds up, and a broken price can never read as free (`chargeMicro`). GLM 5.3 Flash is $0.08 in and $0.50 out per million tokens. It is the default, and it is free in the app's chat for people, up to 50 questions a day, while the day's shared free budget lasts. Agents pay their own way.

**Paying.** Credit runs from $1 to $1,000. From the vault it is a `boxpay` route like any purchase, and it costs about 2% over the credit, for the route. It lands in Tether on NEAR when the usual route is paused. Credit can also be paid from the Gram wallet.

**Usage.** Each request's model, tokens, cache and cost, by account, API key and agent, kept for up to 90 days, newest 5,000 rows. Counts and costs only: GhosterDex does not keep what was asked or answered. In the app's chat and in `ai_ask`, a recovery phrase or private key is refused before it can reach a model (`looksLikeSecret`, [src/lib/secretGuard.ts](../src/lib/secretGuard.ts)). The API does not screen what a key sends.

**The API.** `https://ghosterdex.com/api/ai/v1` takes OpenAI's chat completions, with streaming and, on the models that take them, tools. Any tool that speaks that API can use a key from the app, and spend the same credit ([worker/aiapi.ts](../worker/aiapi.ts)).

## Agent Wallets

An agent gets a wallet of its own, the same shape as a person's, so its money features work through the kit. Not in the kit: NEAR staking, Move to vault, Trade Factory passes, Cash and the browser.

- **The kit.** [agent/kit](../agent/kit) is one file, `gdx.mjs`, with 43 commands, as a command line and as an MCP server. `npm run verify:kit` proves the served file is built from this source.
- **The key.** Made on the agent's machine (`~/.ghosterdex/wallet.json`). The agent logs in with a TON Connect `ton_proof`, and signs each vault move as `signData`, exactly as the phone does.
- **The owner.** A person pairs with an agent in **Explore, Agent Wallets**, using a code, and compares a check code to be sure the account is the agent's. They can fund it, see what it holds and ask for everything back (`return_to_owner`). From a day after pairing, the agent's key can also reach them sealed to devices they approve, so they can bring the money home while the agent is offline.

**New: agents pay for their own thinking.**

- **`ai_add_credit`** buys credit with the agent's own money. `choosePayer` decides what pays: a coin the agent names, otherwise a vault stablecoin, then the vault's Gram, then any vault coin that covers it alone, and the public Gram wallet only after those. The vault comes first because its route is private ([test/pay-with.test.ts](../test/pay-with.test.ts)). The path is order, `boxpay` quote, signature, execute, then follow until delivered.
- **`ai_ask`, `ai_models`, `ai_new_key`, `ai_revoke_key`, `ai_usage`** ask a question, list models with where each runs, manage the agent's API keys, and read what it spent, to the micro-dollar.
- **An agent can run on it.** Point an OpenAI-compatible agent framework at `https://ghosterdex.com/api/ai/v1` with a key the agent made, and its own thinking is paid from its own credit, on a private model if it picks one.
- **The owner sees it.** The agent's credit, keys and usage appear on the owner's sheet, and the owner can add credit for it.

## The browser's AI scan

**New, closed source, Android only.** The wallet's browser for third-party apps asks a private NEAR AI model about a site before you connect and about a transaction before you sign. Since Nov 11 it is free: GhosterDex pays NEAR AI for each scan at cost, and a person's Private AI credit is not touched. Their usage history shows each scan as free.

- **The model** is `z-ai/glm-5.3-flash`, or another ready model on secure hardware. It is never a model outside secure hardware, and with none ready the scan reports that it failed.
- **What it is shown:** the site's name and a page's own words and counts, or what a transaction would move and to what kind of account. Never who is asking, and never a wallet address.
- **Measured first.** What the model is told was tried on the real model before it replaced the old wording: 150 real thefts and 143 honest transactions from the public chain, 60 ordinary payments, and 890 real pages, some from public scam lists and some honest. A wording that did worse on the real pages was dropped.
- **The stop** that catches a page asking for a recovery phrase or key is local and free. The AI can only raise a warning, and the words on screen come from the app, not from the model.
- **What is kept:** the server logs and stores no URL, page or answer. It keeps the usage row every request leaves, and a domain's age for a week under a hash. rdap.org is asked a domain's age, TonAPI runs the transaction preview and gives prices, and the list of most visited sites comes from tranco-list.eu in a request that carries nothing about anyone.

## Other doors

**Trade Factory passes** are paid from the vault by the same `boxpay` route. The trading calls themselves do not use NEAR.

**The connector.** `https://ghosterdex.com/mcp` is a read-only MCP server with 8 tools. Its `quote` prices any vault pair with nothing moving, through NEAR Intents. Run `npm run demo:wallet`.

**Cash (New, not yet open).** Naira and shillings in and out of the vault through a partner's hosted widget, where a purchase pays a `deposit` route into the vault. It is switched on only for the operator, so it is not part of what you can try, and its code is closed.
