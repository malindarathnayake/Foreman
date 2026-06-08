# Proxy CA Certificate Restore Notes

This documents how to restore dependencies behind a corporate TLS inspection proxy using a local CA certificate file.

The npm restore for this repo succeeded on Windows with:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
$env:NODE_EXTRA_CA_CERTS = $env:CORP_CA_CERT
$env:npm_config_cafile = $env:CORP_CA_CERT
npm ci
```

Use session-scoped environment variables first. Persist values only after proving the command works.

## Certificate File

Expected format:

- PEM/Base64 X.509 CA certificate.
- File may use `.crt`, `.cer`, or `.pem`.
- The file should contain one or more `-----BEGIN CERTIFICATE-----` blocks.

Check the file path before running restores:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
Test-Path $env:CORP_CA_CERT
```

Do not disable TLS verification with settings such as `strict-ssl=false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, Maven insecure transport flags, `GOINSECURE`, or Ruby SSL verify disable flags unless you are doing a short diagnostic that will not be committed or reused.

## Intune Deployment Pattern

Yes, Intune can push this setup. Prefer a two-part deployment:

1. Deploy the CA as a Trusted Certificate profile so Windows, Go, browsers, and system-trust-aware tools trust it.
2. Deploy the PEM/CRT file and environment variables with an Intune PowerShell script or Win32 app for tools that need a file path.

Recommended Windows path:

```text
C:\ProgramData\Company\Certs\SocketFW_CA.crt
```

Intune script settings for machine-wide variables:

| Setting | Value |
|---|---|
| Run this script using logged-on credentials | No |
| Run script in 64-bit PowerShell host | Yes |
| Enforce script signature check | Match tenant policy |

Example Intune PowerShell script:

```powershell
$ErrorActionPreference = "Stop"

$certDir = Join-Path $env:ProgramData "Company\Certs"
$certPath = Join-Path $certDir "SocketFW_CA.crt"

New-Item -ItemType Directory -Force -Path $certDir | Out-Null

# For a Win32 app package, place SocketFW_CA.crt beside this script.
Copy-Item -LiteralPath ".\SocketFW_CA.crt" -Destination $certPath -Force

# Trust for Windows/system-store-aware tools.
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null

# Shared pointer for scripts and developers.
[Environment]::SetEnvironmentVariable("CORP_CA_CERT", $certPath, "Machine")

# Node/npm restore.
[Environment]::SetEnvironmentVariable("NODE_EXTRA_CA_CERTS", $certPath, "Machine")
[Environment]::SetEnvironmentVariable("NPM_CONFIG_CAFILE", $certPath, "Machine")

# Python/pip fallback when system trust is not enough.
[Environment]::SetEnvironmentVariable("PIP_CERT", $certPath, "Machine")
[Environment]::SetEnvironmentVariable("REQUESTS_CA_BUNDLE", $certPath, "Machine")
[Environment]::SetEnvironmentVariable("CURL_CA_BUNDLE", $certPath, "Machine")

# Bundler fallback.
[Environment]::SetEnvironmentVariable("BUNDLE_SSL_CA_CERT", $certPath, "Machine")
```

Avoid setting machine-wide `SSL_CERT_FILE` unless the file is a complete CA bundle, not just the corporate root. `SSL_CERT_FILE` can override default OpenSSL CA discovery for multiple ecosystems. Use it per shell when troubleshooting Ruby, Go on Unix, or OpenSSL-based tools.

Maven needs a Java truststore, not just the raw `.crt`. Manage Maven separately if needed:

```powershell
$trustStore = Join-Path $certDir "SocketFW_CA.p12"
keytool -importcert `
  -noprompt `
  -alias socketfw-ca `
  -file "$certPath" `
  -keystore "$trustStore" `
  -storetype PKCS12 `
  -storepass changeit

$mavenOpts = "-Djavax.net.ssl.trustStore=$trustStore -Djavax.net.ssl.trustStoreType=PKCS12 -Djavax.net.ssl.trustStorePassword=changeit"
[Environment]::SetEnvironmentVariable("MAVEN_OPTS", $mavenOpts, "Machine")
```

Caveats:

- The Maven truststore step requires `keytool` from a JDK to be present when the Intune script runs.
- New environment variables are picked up by new processes. Restart terminals, IDEs, build agents, and sometimes sign out/in.
- If multiple teams use different proxy CAs, deploy by device group and avoid global values on shared machines.
- Prefer machine variables for managed developer workstations. Use user variables only when tool config must differ per developer.

## npm and Node

Use both Node and npm settings:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
$env:NODE_EXTRA_CA_CERTS = $env:CORP_CA_CERT
$env:npm_config_cafile = $env:CORP_CA_CERT
npm ci
```

Why both:

- `NODE_EXTRA_CA_CERTS` extends Node's trusted CA set when the Node process starts.
- `npm_config_cafile` maps to npm's `cafile` config and points npm registry fetches at the CA bundle.

Useful checks:

```powershell
node -p "process.env.NODE_EXTRA_CA_CERTS"
npm config get cafile
npm ping
```

Optional project-local config:

```powershell
npm config set cafile "$env:CORP_CA_CERT" --location=project
```

## Maven

Maven runs on the JVM. For portable restores, import the CA into a Java truststore and pass that truststore through `MAVEN_OPTS`.

Create a repo-local truststore:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
New-Item -ItemType Directory -Force .certs | Out-Null
keytool -importcert `
  -noprompt `
  -alias socketfw-ca `
  -file "$env:CORP_CA_CERT" `
  -keystore ".certs\socketfw-ca.p12" `
  -storetype PKCS12 `
  -storepass changeit
```

Restore with Maven:

```powershell
$trustStore = (Resolve-Path ".certs\socketfw-ca.p12").Path
$env:MAVEN_OPTS = "-Djavax.net.ssl.trustStore=$trustStore -Djavax.net.ssl.trustStoreType=PKCS12 -Djavax.net.ssl.trustStorePassword=changeit"
mvn -U dependency:go-offline
```

Use the same `MAVEN_OPTS` for normal builds:

```powershell
mvn test
```

When `javax.net.ssl.trustStore` is set, that JVM uses the provided truststore for trust decisions. If the build also needs public internet CAs, import the corporate CA into a truststore that already contains the needed public roots, or validate that the JDK still resolves all required repositories.

Do not commit truststores that contain private keys or secrets. A CA-only truststore is lower risk, but still prefer documenting how to regenerate it.

## Go

Go generally uses the operating system trust store for TLS verification.

On Windows, prefer installing the corporate CA into the current user's trusted root store:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
Import-Certificate -FilePath "$env:CORP_CA_CERT" -CertStoreLocation Cert:\CurrentUser\Root
go mod download
```

On Unix systems other than macOS, Go's `crypto/x509` package documents `SSL_CERT_FILE` and `SSL_CERT_DIR` as overrides for system certificate locations:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
$env:SSL_CERT_FILE = $env:CORP_CA_CERT
go mod download
```

If `go mod download` uses Git over HTTPS for private or direct modules, Git has its own CA setting:

```powershell
$env:GIT_SSL_CAINFO = $env:CORP_CA_CERT
go mod download
```

Use `GOINSECURE` only for deliberately insecure module paths. It is not the right fix for trusting a corporate CA.

## Python and pip

Modern pip on Python 3.10+ can use system certificates through `truststore`, so no env var may be needed if the CA is already trusted by the OS.

If pip still fails, use pip's explicit certificate option:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
$env:PIP_CERT = $env:CORP_CA_CERT
python -m pip install -r requirements.txt
```

For Python tools that use `requests`, also set:

```powershell
$env:REQUESTS_CA_BUNDLE = $env:CORP_CA_CERT
$env:CURL_CA_BUNDLE = $env:CORP_CA_CERT
```

Equivalent one-command pip form:

```powershell
python -m pip install --cert "$env:CORP_CA_CERT" -r requirements.txt
```

Optional user-level pip config:

```powershell
python -m pip config set global.cert "$env:CORP_CA_CERT"
```

## Ruby, RubyGems, and Bundler

Bundler supports `ssl_ca_cert` through the `BUNDLE_SSL_CA_CERT` environment variable.

For Bundler:

```powershell
$env:CORP_CA_CERT = "C:\Users\MalindaRathnayake\Downloads\SocketFW_CA.crt"
$env:BUNDLE_SSL_CA_CERT = $env:CORP_CA_CERT
bundle install
```

For Ruby/RubyGems/OpenSSL fallback:

```powershell
$env:SSL_CERT_FILE = $env:CORP_CA_CERT
gem install rake
```

For Bundler config instead of env:

```powershell
bundle config set --local ssl_ca_cert "$env:CORP_CA_CERT"
bundle install
```

Prefer `--local` inside a project over global config unless every Ruby project on the machine needs the same CA.

RubyGems also supports `:ssl_ca_cert:` in gem configuration files. Prefer environment variables first when testing a one-off restore.

## Quick Matrix

| Tool | Preferred session env/config | Restore command |
|---|---|---|
| Node runtime | `NODE_EXTRA_CA_CERTS=$env:CORP_CA_CERT` | `node ...` |
| npm | `npm_config_cafile=$env:CORP_CA_CERT` | `npm ci` |
| Maven | `MAVEN_OPTS=-Djavax.net.ssl.trustStore=...` | `mvn -U dependency:go-offline` |
| Go on Windows | Windows user root store | `go mod download` |
| Go on Unix non-macOS | `SSL_CERT_FILE=$env:CORP_CA_CERT` | `go mod download` |
| Git fallback for Go/private modules | `GIT_SSL_CAINFO=$env:CORP_CA_CERT` | `go mod download` |
| pip | `PIP_CERT=$env:CORP_CA_CERT` | `python -m pip install -r requirements.txt` |
| Python requests/curl-style tools | `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` | tool-specific |
| Bundler | `BUNDLE_SSL_CA_CERT=$env:CORP_CA_CERT` | `bundle install` |
| RubyGems/Ruby OpenSSL | `SSL_CERT_FILE=$env:CORP_CA_CERT` | `gem install ...` |

## Sources

- Node.js CLI documentation for `NODE_EXTRA_CA_CERTS`: https://nodejs.org/api/cli.html
- Node.js enterprise network CA configuration: https://nodejs.org/en/learn/http/enterprise-network-configuration
- npm config documentation for `cafile`: https://docs.npmjs.com/cli/using-npm/config/
- Microsoft Intune trusted certificate profiles: https://learn.microsoft.com/en-us/intune/device-configuration/certificates/trusted-root-profiles
- Microsoft Intune PowerShell scripts for Windows devices: https://learn.microsoft.com/en-us/intune/device-management/tools/run-powershell-scripts-windows
- PowerShell environment variable persistence: https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_environment_variables
- Maven HTTPS repository guide: https://maven.apache.org/guides/mini/guide-repository-ssl.html
- Java Secure Socket Extension reference: https://docs.oracle.com/en/java/javase/24/security/java-secure-socket-extension-jsse-reference-guide.html
- Go `crypto/x509` package documentation: https://pkg.go.dev/crypto/x509
- Git config documentation for `http.sslCAInfo`: https://git-scm.com/docs/git-config
- pip HTTPS certificate documentation: https://pip.pypa.io/en/stable/topics/https-certificates/
- Bundler config documentation for `ssl_ca_cert`: https://bundler.io/man/bundle-config.1.html
- RubyGems TLS/SSL troubleshooting guide: https://guides.rubygems.org/rubygems_tls_ssl_troubleshooting_guide/
- OpenSSL certificate location behavior: https://docs.openssl.org/3.3/man3/SSL_CTX_load_verify_locations/
