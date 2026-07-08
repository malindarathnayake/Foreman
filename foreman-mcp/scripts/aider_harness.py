#!/usr/bin/env python3
"""Foreman's external aider transport (Unit 3b-aider-harness).

This script is spawned as a CHILD PROCESS by the `aider_worker` MCP tool
(src/tools/aiderWorker.ts) via its `externalCli` helper — it is NOT part of the
Node dependency graph and uses only the Python standard library plus the `aider`
package, which the operator installs separately (`pip install aider-chat`).
Foreman never installs it and never assumes it is present.

Two invocation modes, selected by argv / stdin:

  Probe mode  (`<python> aider_harness.py --probe`, empty stdin)
      A side-effect-free capability check: no file writes, no network calls,
      nothing beyond attempting `import aider`. Prints a small sentinel JSON to
      stdout and exits 0 if aider is importable, or exits 20 (with its own
      sentinel JSON body) if it is not. The TypeScript caller
      (`probeAiderCapability` in src/lib/externalCli.ts) reads ONLY the exit
      code: 0 means available, any other code means absent.

  Main mode   (`<python> aider_harness.py`, a JSON request object on stdin)
      Drives exactly one headless aider edit run inside the caller-supplied
      worktree directory (`request["cwd"]`) and reports run metadata back as a
      single JSON object on stdout. Foreman computes the git diff itself
      afterwards from the worktree — this harness NEVER emits patch/diff bytes
      on stdout (R3).

Secrets discipline [CWE-532]: `request["api_key"]` is placed into this
process's OWN environment so litellm/aider can read it — it must NEVER be
written to stdout, stderr, or embedded in any exception/error message this
script prints. Every error path below scrubs the key value out of whatever
text it is about to emit, then bounds the length, before printing it.
"""

import sys
import os
import json

# ── Exit code sentinels (contract with src/lib/externalCli.ts) ────────────────
EXIT_OK = 0
EXIT_BAD_STDIN = 2
EXIT_GENERIC_ERROR = 1
EXIT_PROBE_MISSING = 20

# ── Output size caps (secret/PII discipline — never dump unbounded text) ──────
STDERR_MAX = 500
ERROR_DETAIL_MAX = 200


def _scrub(text, secret):
    """Best-effort redaction: replace an exact non-empty secret substring with ***."""
    if secret:
        text = text.replace(secret, "***")
    return text


def _bounded_exc_message(exc, secret, cap):
    """type(exc).__name__ + str(exc), scrubbed of the secret (if any), then bounded."""
    msg = "%s: %s" % (type(exc).__name__, exc)
    msg = _scrub(msg, secret)
    return msg[:cap]


def _probe():
    """Side-effect-free capability check. Only attempts `import aider`."""
    try:
        import aider  # noqa: F401
    except Exception:
        print(json.dumps({"ok": False, "error_kind": "binary_not_found", "missing": "aider", "probe": True}))
        return EXIT_PROBE_MISSING
    print(json.dumps({"ok": True, "probe": True}))
    return EXIT_OK


def _classify_llm_error(exc):
    """True when exc is a litellm-surfaced endpoint/API error class. Never throws."""
    try:
        import litellm

        llm_err_types = (
            litellm.exceptions.APIError,
            litellm.exceptions.APIConnectionError,
            litellm.exceptions.AuthenticationError,
            litellm.exceptions.RateLimitError,
            litellm.exceptions.Timeout,
        )
    except Exception:
        llm_err_types = ()
    if not llm_err_types:
        return False
    try:
        return isinstance(exc, llm_err_types)
    except Exception:
        return False


def _empty_diagnostics():
    """Zeroed diagnostic fields shared by the llm_error and success responses."""
    return {
        "aider_edited_files": [],
        "num_malformed_responses": 0,
        "num_reflections": 0,
        "num_exhausted_context_windows": 0,
        "total_tokens_sent": 0,
        "total_tokens_received": 0,
        "total_cost": 0.0,
        "reflections_capped": False,
    }


def _run_main(request):
    """Runs one headless aider edit inside request['cwd']. Returns the response dict."""
    api_key = request.get("api_key", "")

    # Endpoint wiring: litellm/aider read these env vars, so set them (and cwd)
    # BEFORE importing aider — never after.
    os.environ["OPENAI_API_BASE"] = request["api_base"]
    os.environ["OPENAI_API_KEY"] = api_key
    os.chdir(request["cwd"])

    # Isolate stdout: aider/rich write chatter (banners, edit notices, assistant text)
    # to sys.stdout during the run. Redirect it to stderr for the duration so ONLY the
    # final metadata JSON (written by main() to the saved real stdout) reaches stdout —
    # the "ONE JSON object on stdout" / R3 contract. Restored in finally.
    saved_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        from aider.models import Model  # aider/models.py
        from aider.coders import Coder  # aider/coders/base_coder.py:125 (Coder.create)
        from aider.io import InputOutput

        model = Model(request["model"])  # "openai/<served-name>"
        model.system_prompt_prefix = request["system_prompt_prefix"]  # discipline addendum
        model.extra_params = getattr(model, "extra_params", None) or {}
        model.extra_params["num_ctx"] = request["num_ctx"]  # served context
        if request.get("reasoning_tag"):  # 3d reasoning-strip
            model.reasoning_tag = request["reasoning_tag"]  # e.g. "think" -> CoT stripped

        coder = Coder.create(  # base_coder.py:125
            main_model=model,
            edit_format=request["edit_format"],
            io=InputOutput(yes=True, pretty=False),  # pretty=False: plain text, fewer control codes
            fnames=request["fnames"],
            read_only_fnames=request.get("read_only_fnames") or [],
            use_git=False,
            auto_commits=False,
            dirty_commits=False,
            stream=False,  # deterministic headless — MANDATORY, do not omit/change
        )
        coder.max_reflections = request["max_reflections"]

        try:
            coder.run(with_message=request["message"], preproc=False)  # base_coder.py:876
        except Exception as exc:
            if _classify_llm_error(exc):
                response = {"ok": True}
                response.update(_empty_diagnostics())
                response["error_kind"] = "llm_error"
                response["error_detail"] = _bounded_exc_message(exc, api_key, ERROR_DETAIL_MAX)
                return response
            raise

        num_reflections = getattr(coder, "num_reflections", 0) or 0
        max_reflections = request["max_reflections"]

        return {
            "ok": True,
            "aider_edited_files": sorted(list(getattr(coder, "aider_edited_files", None) or [])),
            "num_malformed_responses": getattr(coder, "num_malformed_responses", 0) or 0,
            "num_reflections": num_reflections,
            "num_exhausted_context_windows": getattr(coder, "num_exhausted_context_windows", 0) or 0,
            "total_tokens_sent": getattr(coder, "total_tokens_sent", 0) or 0,
            "total_tokens_received": getattr(coder, "total_tokens_received", 0) or 0,
            "total_cost": getattr(coder, "total_cost", 0.0) or 0.0,
            "reflections_capped": num_reflections >= max_reflections,
            "error_kind": "none",
            "error_detail": "",
        }
    finally:
        sys.stdout = saved_stdout


def main():
    # Captured ONCE, before anything else, so the final response is always written to
    # the REAL stdout — even after _run_main() below redirects sys.stdout to sys.stderr
    # for the duration of the aider run (see _run_main's docstring / R3 contract).
    real_stdout = sys.stdout

    if "--probe" in sys.argv[1:]:
        return _probe()

    raw = sys.stdin.read()
    try:
        request = json.loads(raw)
    except Exception:
        # Fixed generic message — never the raw exception text. JSONDecodeError does not
        # echo the input today, but this closes the exposure surface defensively.
        sys.stderr.write("invalid JSON on stdin\n")
        return EXIT_BAD_STDIN

    api_key = request.get("api_key", "") if isinstance(request, dict) else ""

    # Unexpected: the pre-flight probe (--probe) should have already caught this.
    try:
        import aider  # noqa: F401
    except Exception:
        sys.stderr.write("aider is not importable in main mode (probe should have caught this)\n")
        return EXIT_GENERIC_ERROR

    try:
        response = _run_main(request)
    except Exception as exc:
        # Any exception here (other than the litellm-classified branch handled
        # inside _run_main) is the generic nonzero-exit path: bounded, scrubbed
        # stderr only — stdout MUST stay clean (no partial/!ok JSON object).
        sys.stderr.write(_bounded_exc_message(exc, api_key, STDERR_MAX) + "\n")
        return EXIT_GENERIC_ERROR

    # Exactly one JSON object on stdout — metadata only, never patch/diff bytes. Written
    # to the REAL stdout captured above, bypassing _run_main's stdout->stderr redirect.
    real_stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
