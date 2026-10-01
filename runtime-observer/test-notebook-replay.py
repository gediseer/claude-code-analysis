import os
import tempfile
from pathlib import Path

import nbformat
from nbclient import NotebookClient


def test_notebook_targets_one_session() -> None:
    root = Path(tempfile.mkdtemp(prefix="observer-notebook-test-"))
    data_root = root / "data"
    session_id = "11111111-1111-4111-8111-111111111111"
    exchange = data_root / "sessions" / session_id / "exchanges" / "0000000001"
    exchange.mkdir(parents=True)
    request = b'{"messages":[{"role":"user","content":"hello"}]}'
    response = (
        b'event: message_start\n'
        b'data: {"type":"message_start","message":{"type":"message","role":"assistant","content":[]}}\n\n'
        b'event: message_stop\n'
        b'data: {"type":"message_stop"}\n\n'
    )
    import hashlib
    import json

    (exchange / "01-client-request.raw").write_bytes(request)
    (exchange / "05-client-response.raw").write_bytes(response)
    (exchange / "01-client-request.headers.redacted.json").write_text(
        json.dumps({"content-type": "application/json"}), encoding="utf-8"
    )
    (exchange / "05-client-response.headers.redacted.json").write_text(
        json.dumps({"content-type": "text/event-stream"}), encoding="utf-8"
    )
    (exchange / "summary.json").write_text(
        json.dumps(
            {
                "method": "POST",
                "path": "/api/anthropic/v1/messages",
                "acceptedAt": "2026-10-01T00:00:00.000Z",
                "completedAt": "2026-10-01T00:00:01.000Z",
                "globalSequence": 1,
                "exchangeId": "0000000001",
                "classification": {
                    "kind": "session",
                    "sessionId": session_id,
                    "evidence": "header+body",
                },
                "state": "completed",
                "responseStatus": 200,
                "requestBytes": len(request),
                "requestSha256": hashlib.sha256(request).hexdigest(),
                "responseBytes": len(response),
                "responseSha256": hashlib.sha256(response).hexdigest(),
            }
        ),
        encoding="utf-8",
    )
    (exchange / "02-client-request.parsed.json").write_bytes(request)
    ledger_rows = [
        {
            "event": "accepted",
            "globalSequence": 1,
            "exchangeId": "0000000001",
            "classification": {
                "kind": "session",
                "sessionId": session_id,
                "evidence": "header+body",
            },
        },
        {
            "event": "terminal",
            "summary": {
                "globalSequence": 1,
                "exchangeId": "0000000001",
                "classification": {
                    "kind": "session",
                    "sessionId": session_id,
                    "evidence": "header+body",
                },
            },
        },
    ]
    (data_root / "ledger.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in ledger_rows), encoding="utf-8"
    )
    (data_root / "sessions" / session_id / "parity-manifest.json").write_text(
        json.dumps({"status": "PARITY_VERIFIED_WITH_DECLARED_ROUTING"}),
        encoding="utf-8",
    )

    notebook_path = Path(__file__).parents[3] / "agent-maestro-observer" / "data" / "build_session_replays.ipynb"
    notebook = nbformat.read(notebook_path, as_version=4)
    previous_data_root = os.environ.get("OBSERVER_DATA_ROOT")
    previous_session_id = os.environ.get("OBSERVER_SESSION_ID")
    previous_repo_root = os.environ.get("OBSERVER_REPO_ROOT")
    os.environ["OBSERVER_DATA_ROOT"] = str(data_root)
    os.environ["OBSERVER_REPO_ROOT"] = str(notebook_path.parents[1])
    os.environ["OBSERVER_SESSION_ID"] = session_id
    try:
        NotebookClient(notebook, timeout=120, kernel_name="python3").execute(cwd=str(notebook_path.parent))
    finally:
        if previous_data_root is None:
            os.environ.pop("OBSERVER_DATA_ROOT", None)
        else:
            os.environ["OBSERVER_DATA_ROOT"] = previous_data_root
        if previous_session_id is None:
            os.environ.pop("OBSERVER_SESSION_ID", None)
        else:
            os.environ["OBSERVER_SESSION_ID"] = previous_session_id
        if previous_repo_root is None:
            os.environ.pop("OBSERVER_REPO_ROOT", None)
        else:
            os.environ["OBSERVER_REPO_ROOT"] = previous_repo_root

    output = data_root / "sessions" / session_id / "runtime-replay.html"
    document = output.read_text(encoding="utf-8")
    assert document.count('<article class="exchange"') == 1
    assert "INTEGRITY FAILED" not in document
    assert "PARITY_VERIFIED_WITH_DECLARED_ROUTING" in document
    assert f"Session {session_id}" in document


if __name__ == "__main__":
    test_notebook_targets_one_session()
