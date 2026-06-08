# Socket Security Scan - 2026-06-08

## Summary

| Status | Scan | Date | Validated | Link |
|--------|------|------|-----------|------|
| ✅ | Socket full scan | 2026-06-08 15:47:28 UTC | Scan creation validated; policy report validation blocked by Socket API permission `security-policy` read | [Socket report](https://socket.dev/dashboard/org/fts/sbom/26b91aee-2d2d-4f54-999e-a16730729f5d) |

## Scan Metadata

```json
{
  "scanner": "Socket CLI",
  "scanner_version": "1.1.92",
  "scan_id": "26b91aee-2d2d-4f54-999e-a16730729f5d",
  "scan_type": "socket",
  "organization": "fts",
  "repository": "Foreman",
  "branch": "release/v0.1.1",
  "commit_hash": "933ba29f7c53a6a69b112117100681b57b0a7426",
  "created_at": "2026-06-08T15:47:28.867Z",
  "html_report_url": "https://socket.dev/dashboard/org/fts/sbom/26b91aee-2d2d-4f54-999e-a16730729f5d",
  "included_files": 2,
  "unmatched_files": []
}
```

## Command

```powershell
socket scan create . `
  --json `
  --tmp `
  --no-set-as-alerts-page `
  --repo Foreman `
  --branch release/v0.1.1 `
  --commit-hash 933ba29f7c53a6a69b112117100681b57b0a7426 `
  --no-banner `
  --no-spinner
```

## Notes

- The scan was created successfully and uploaded to Socket.
- Socket found two local manifest files in `foreman-mcp`.
- `socket scan create --report` was attempted first, but the configured token could not read the org security policy endpoint and returned `403 Forbidden`.
- Because policy-report mode was unavailable, this artifact validates scan creation and links the dashboard result; it does not claim Socket policy pass/fail.
