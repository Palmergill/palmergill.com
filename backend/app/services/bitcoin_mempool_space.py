import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional


class MempoolSpaceError(Exception):
    """Raised when mempool.space cannot serve a read-only Bitcoin request."""


class MempoolSpaceClient:
    def __init__(self, base_url: Optional[str] = None, timeout: Optional[float] = None):
        self.base_url = (base_url or os.getenv("BITCOIN_MEMPOOL_API_URL") or "https://mempool.space/api").rstrip("/")
        self.timeout = timeout or float(os.getenv("BITCOIN_MEMPOOL_TIMEOUT_SECONDS", "10"))

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def get_json(self, path: str) -> Any:
        return self._request(path, expect_json=True)

    def get_text(self, path: str) -> str:
        return self._request(path, expect_json=False)

    def get_tip_height(self) -> int:
        return int(self.get_text("/blocks/tip/height"))

    def get_tip_hash(self) -> str:
        return self.get_text("/blocks/tip/hash")

    def get_block_hash(self, height: int) -> str:
        return self.get_text(f"/block-height/{height}")

    def get_block(self, block_hash: str) -> Dict[str, Any]:
        return self.get_json(f"/block/{urllib.parse.quote(block_hash)}")

    def get_blocks(self, start_height: int) -> List[Dict[str, Any]]:
        return self.get_json(f"/v1/blocks/{start_height}")

    def get_mempool(self) -> Dict[str, Any]:
        return self.get_json("/mempool")

    def get_recommended_fees(self) -> Dict[str, Any]:
        return self.get_json("/v1/fees/recommended")

    def get_transaction(self, txid: str) -> Dict[str, Any]:
        return self.get_json(f"/tx/{urllib.parse.quote(txid)}")

    def _request(self, path: str, expect_json: bool) -> Any:
        url = f"{self.base_url}{path}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json" if expect_json else "text/plain",
                "User-Agent": "palmergill-bitcoin-chat/1.0",
            },
            method="GET",
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read().decode("utf-8")
        except socket.timeout as exc:
            raise MempoolSpaceError("Timed out waiting for mempool.space response") from exc
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 404:
                raise MempoolSpaceError("mempool.space could not find that Bitcoin object") from exc
            raise MempoolSpaceError(f"mempool.space returned HTTP {exc.code}: {detail[:200]}") from exc
        except urllib.error.URLError as exc:
            raise MempoolSpaceError(f"Could not reach mempool.space: {exc}") from exc

        if not expect_json:
            return body.strip()

        try:
            return json.loads(body)
        except json.JSONDecodeError as exc:
            raise MempoolSpaceError("mempool.space returned invalid JSON") from exc


mempool_space_client = MempoolSpaceClient()
