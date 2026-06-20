"""
Test fixtures for the parser sidecar.

`app.main` imports `magic` (libmagic) and `markitdown` at module load. Those are
present in the runtime/CI image, but not necessarily on a bare dev box. To keep
the unit tests runnable everywhere we install lightweight stubs ONLY when the
real packages are missing — when they are installed, the real modules win and
behaviour is unchanged. Tests drive parsing behaviour by monkeypatching
`app.main.magic.from_buffer` / `app.main._markitdown.convert` directly, so they
do not depend on which variant is loaded here.
"""

from __future__ import annotations

import sys
import types


def _ensure_magic_stub() -> None:
    try:
        import magic  # noqa: F401
    except Exception:
        stub = types.ModuleType("magic")

        def from_buffer(buf: bytes, mime: bool = False) -> str:
            return "application/octet-stream"

        stub.from_buffer = from_buffer  # type: ignore[attr-defined]
        sys.modules["magic"] = stub


def _ensure_markitdown_stub() -> None:
    try:
        import markitdown  # noqa: F401
    except Exception:
        stub = types.ModuleType("markitdown")

        class MarkItDown:  # minimal surface used by app.main
            def convert(self, path: str):  # pragma: no cover - overridden in tests
                raise RuntimeError("markitdown stub not configured for this test")

        stub.MarkItDown = MarkItDown  # type: ignore[attr-defined]
        sys.modules["markitdown"] = stub


_ensure_magic_stub()
_ensure_markitdown_stub()
