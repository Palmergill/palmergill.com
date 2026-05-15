# Bitcoin Chat Setup

This documents the production wiring for the Bitcoin Chat app at `/bitcoin-chat/`.

Last reviewed against the repo on May 15, 2026.

## Architecture

```text
bitcoin-chat frontend
  -> /api/bitcoin/*
  -> Railway FastAPI backend
  -> Cloudflare Tunnel
  -> Mac mini Bitcoin-Qt RPC
  -> Bitcoin Core node data on external SSD
```

The Bitcoin node runs on the Mac mini with its data directory on:

```text
/Volumes/SSD/Bitcoin Node/bitcoin
```

The production RPC tunnel hostname is:

```text
https://bitcoin-rpc.palmergill.com/
```

## Bitcoin Core Config

The Bitcoin Core config lives at:

```text
/Volumes/SSD/Bitcoin Node/bitcoin/bitcoin.conf
```

It should contain:

```conf
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
rpcport=8332
rpcuser=railway_bitcoin_chat
rpcpassword=<secret>
rpcwhitelistdefault=0
rpcwhitelist=railway_bitcoin_chat:getblockchaininfo,getblockcount,getblockhash,getblock,getmempoolinfo,estimatesmartfee,getrawtransaction

prune=715255
```

Restart Bitcoin-Qt after changing `bitcoin.conf`.

## Cloudflare Tunnel

Cloudflare Tunnel publishes the local Bitcoin RPC listener without opening inbound ports on the Mac mini.

Tunnel service target:

```text
http://127.0.0.1:8332
```

Public hostname:

```text
bitcoin-rpc.palmergill.com
```

The tunnel connector must show as healthy in Cloudflare Zero Trust.

## Railway Environment

Set these variables in the Railway backend service:

```bash
BITCOIN_RPC_URL=https://bitcoin-rpc.palmergill.com/
BITCOIN_RPC_USER=railway_bitcoin_chat
BITCOIN_RPC_PASSWORD=<exact rpcpassword from bitcoin.conf>
BITCOIN_RPC_TIMEOUT_SECONDS=20
BITCOIN_NETWORK=main
BITCOIN_MAX_MINED_STATS_BLOCKS=1008
BITCOIN_CHAT_MAX_TOOL_CALLS=6
BITCOIN_CHAT_MODEL_TIMEOUT_SECONDS=30
BITCOIN_CHAT_MAX_SESSION_MESSAGES=12
BITCOIN_CHAT_MODEL=gpt-5.5
BITCOIN_CHAT_REASONING_EFFORT=low
BITCOIN_CHAT_VERBOSITY=medium
OPENAI_API_KEY=<OpenAI API key for natural-language chat>
```

If the password ends with `=`, include the trailing `=` in Railway. Do not wrap the value in quotes.

`OPENAI_API_KEY` is optional for node smoke tests. When it is missing, `/api/bitcoin/chat` falls back to deterministic read-only answers for blocks, transactions, fees, node status, and mined-BTC queries. Set it to enable the natural-language Bitcoin assistant and technical explanations.

`BITCOIN_CHAT_MODEL_TIMEOUT_SECONDS` controls the model call timeout, and `BITCOIN_CHAT_MAX_SESSION_MESSAGES` caps the rolling chat history kept per session.

## Backend Endpoints

The shared FastAPI backend exposes:

- `GET /api/bitcoin/health`
- `GET /api/bitcoin/status`
- `GET /api/bitcoin/block/latest`
- `GET /api/bitcoin/block/{height_or_hash}`
- `GET /api/bitcoin/tx/{txid}`
- `GET /api/bitcoin/mempool/summary`
- `POST /api/bitcoin/chat`

## Verification

Check that Bitcoin-Qt loaded the config:

```bash
rg -n "Config file|Binding RPC|rpcwhitelist" "/Volumes/SSD/Bitcoin Node/bitcoin/debug.log"
```

Check that Bitcoin Core is listening locally:

```bash
lsof -nP -iTCP:8332 -sTCP:LISTEN
```

Check the tunnel with intentionally wrong credentials. A `401` means the tunnel is reaching Bitcoin Core and auth is protecting it:

```bash
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  --max-time 8 \
  --user railway_bitcoin_chat:wrong-password \
  --data-binary '{"jsonrpc":"1.0","id":"probe","method":"getblockchaininfo","params":[]}' \
  -H 'content-type: text/plain;' \
  https://bitcoin-rpc.palmergill.com/
```

Expected:

```text
401
```

Check with the real password from the Mac mini without printing the secret:

```bash
pw=$(sed -n 's/^rpcpassword=//p' "/Volumes/SSD/Bitcoin Node/bitcoin/bitcoin.conf")
curl --silent --show-error --max-time 20 \
  --user "railway_bitcoin_chat:$pw" \
  --data-binary '{"jsonrpc":"1.0","id":"probe","method":"getblockchaininfo","params":[]}' \
  -H 'content-type: text/plain;' \
  https://bitcoin-rpc.palmergill.com/
```

Expected: JSON with `chain`, `blocks`, `headers`, `verificationprogress`, and `initialblockdownload`.

## Troubleshooting

- `401` from the tunnel with real credentials usually means Railway or the shell command is missing part of the password, especially a trailing `=`.
- `403` from Cloudflare can happen with default Python request headers. The backend RPC client sends `User-Agent`, `Accept`, and `Connection: close` headers for tunnel compatibility.
- `500` from `/api/bitcoin/chat` means check Railway logs first. RPC errors should now return a degraded response instead of crashing.
- If the node is still syncing, some calls may be slower. Keep `BITCOIN_RPC_TIMEOUT_SECONDS=20` until initial block download finishes.
- The RPC user is whitelisted to read-only methods used by the app. Do not add wallet, signing, broadcast, or private-key RPC methods.
