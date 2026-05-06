import os
import json
import socket
import urllib.error
import urllib.request
from base64 import b64encode
from typing import Any, Dict, Optional


class BitcoinRPCError(Exception):
    """Raised when Bitcoin Core returns an RPC error or cannot be reached."""


class BitcoinRPCClient:
    def __init__(
        self,
        url: Optional[str] = None,
        user: Optional[str] = None,
        password: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        self.url = url or os.getenv("BITCOIN_RPC_URL")
        self.user = user or os.getenv("BITCOIN_RPC_USER")
        self.password = password or os.getenv("BITCOIN_RPC_PASSWORD")
        self.timeout = timeout or float(os.getenv("BITCOIN_RPC_TIMEOUT_SECONDS", "10"))

    @property
    def configured(self) -> bool:
        return bool(self.url and self.user and self.password)

    def call(self, method: str, params: Optional[list[Any]] = None) -> Any:
        if not self.configured:
            raise BitcoinRPCError("Bitcoin RPC is not configured")

        payload: Dict[str, Any] = {
            "jsonrpc": "1.0",
            "id": "palmergill-bitcoin-chat",
            "method": method,
            "params": params or [],
        }

        credentials = f"{self.user}:{self.password}".encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Basic {b64encode(credentials).decode('ascii')}",
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Connection": "close",
                "User-Agent": "palmergill-bitcoin-chat/1.0",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except socket.timeout as exc:
            raise BitcoinRPCError("Timed out waiting for Bitcoin node response") from exc
        except urllib.error.URLError as exc:
            raise BitcoinRPCError(f"Could not reach Bitcoin node: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise BitcoinRPCError("Bitcoin node returned invalid JSON") from exc

        if body.get("error"):
            message = body["error"].get("message", "Unknown Bitcoin RPC error")
            raise BitcoinRPCError(message)

        return body.get("result")


bitcoin_rpc_client = BitcoinRPCClient()
