"""
Shared-secret authentication for the /parse endpoint.

The guard is opt-in: with PARSER_SECRET unset the sidecar accepts unauthenticated
requests (loopback-bound dev); with it set, /parse requires a matching
X-Parser-Token header. /health is always open so container/k8s probes work
without the secret.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

# Smallest input that exercises the real (pure-python) CSV parse path, so a
# 200 means the request passed auth AND reached the handler.
_SAMPLE = ("doc.csv", b"a,b\n1,2\n", "text/csv")


def _post(token: str | None = None):
    headers = {"X-Parser-Token": token} if token is not None else {}
    files = {"file": (_SAMPLE[0], _SAMPLE[1], _SAMPLE[2])}
    data = {"filename": _SAMPLE[0], "mime_type": _SAMPLE[2]}
    return client.post("/parse", files=files, data=data, headers=headers)


def test_no_secret_allows_unauthenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PARSER_SECRET", raising=False)
    assert _post().status_code == 200


def test_empty_secret_allows_unauthenticated(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "   ")
    assert _post().status_code == 200


def test_secret_set_rejects_missing_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert _post().status_code == 401


def test_secret_set_rejects_wrong_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert _post(token="nope").status_code == 401


def test_secret_set_rejects_empty_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert _post(token="").status_code == 401


def test_secret_set_accepts_correct_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert _post(token="s3cr3t").status_code == 200


def test_duplicate_header_with_one_correct_value_accepted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A proxy/LB may duplicate the header; Starlette joins values with ", ".
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert _post(token="s3cr3t, s3cr3t").status_code == 200


def test_health_always_open(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PARSER_SECRET", "s3cr3t")
    assert client.get("/health").status_code == 200
