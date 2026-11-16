// Eval-only helper: it reads the local Codex config through python3 at startup.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";

// Read credentials into memory only. Python's TOML parser avoids another runner dependency.
const decodeProxyConfig = Schema.decodeUnknownSync(
  Schema.Struct({ url: Schema.String, headers: Schema.Record(Schema.String, Schema.String) }),
);
/** Reads an explicit private eval configuration or the configured `vibeproxy` provider. */
export const proxyConfig = () =>
  decodeProxyConfig(
    JSON.parse(
      NodeChildProcess.execFileSync(
        "python3",
        [
          "-c",
          `
import json, os, pathlib, tomllib
explicit = os.environ.get('LASTCODE_EVAL_PROXY_CONFIG')
if explicit:
    print(json.dumps(json.loads(pathlib.Path(explicit).read_text())))
    raise SystemExit(0)
home = pathlib.Path.home() / '.codex'
providers = tomllib.loads((home / 'config.toml').read_text()).get('model_providers', {})
if 'vibeproxy' not in providers:
    raise SystemExit('No vibeproxy provider configured. Set LASTCODE_EVAL_PROXY_CONFIG to a private JSON file with url and headers for an authorized eval proxy.')
p = providers['vibeproxy']
h = p.get('http_headers', {}).copy()
h.update({k: os.environ[v] for k,v in p.get('env_http_headers', {}).items()})
key = os.environ[p['env_key']] if p.get('env_key') else p.get('experimental_bearer_token')
if not key and p.get('requires_openai_auth'): key = json.loads((home / 'auth.json').read_text()).get('OPENAI_API_KEY')
if key: h['Authorization'] = 'Bearer ' + key
print(json.dumps({'url': p['base_url'].rstrip('/'), 'headers': h}))
`,
        ],
        { encoding: "utf8" },
      ),
    ),
  );
