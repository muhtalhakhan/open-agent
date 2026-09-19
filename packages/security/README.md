# @open-agent/security

Secret stores: somewhere credentials can live other than a plaintext `.env`.

## `SecretStore`

```ts
interface SecretStore {
  readonly name: string // "keychain (service "open-agent")", for error messages
  get(key: string): string | undefined
}
```

`get` returns `undefined` when nothing is stored under `key`, and throws when the store itself cannot be read: not installed, locked, or access denied. That way an operator who asked for the store finds out, instead of the agent quietly running without the credential. It is synchronous because credentials are resolved while the configuration is parsed, before anything else starts. An async backend such as Vault would need that resolution step to become async first.

`resolveCredential` in `@open-agent/providers` consults the store as a last resort: it checks `<NAME>` and `<NAME>_FILE` for every accepted name first, and asks the store only when none of them is set. The store's values get the same validation and the same errors as any other credential, and those errors never contain the value.

## `KeychainSecretStore`

Reads from the OS credential store:

- **macOS**: the Keychain, through `security find-generic-password`.
- **Linux**: the freedesktop Secret Service (GNOME Keyring, KWallet), through libsecret's `secret-tool` (`apt install libsecret-tools`).

Entries are filed under a service (`open-agent` by default) and an account, which is the variable's name. So `OPENAI_API_KEY` in the keychain stands in for `OPENAI_API_KEY` in the environment:

```sh
# macOS (prompts for the value)
security add-generic-password -s open-agent -a OPENAI_API_KEY -w
# Linux (reads the value from stdin)
secret-tool store --label="open-agent OPENAI_API_KEY" service open-agent account OPENAI_API_KEY
```

It drives the platforms' own CLIs rather than native bindings, so there is nothing to compile, and a missing tool shows up as an error message rather than a failed install. The command runner is injectable, so the tests never touch a real keychain. Windows is not supported yet.

In the CLI, set `SECRET_STORE=keychain` to turn it on (and `SECRET_STORE_SERVICE` to change the service). `HTTP_SECRETS=A,B` names `{{A}}`/`{{B}}` placeholders for `http_request` to fetch from the keychain as `HTTP_SECRET_A`/`HTTP_SECRET_B`.

## `MemorySecretStore`

Holds secrets in memory, for tests and for callers that obtain them some other way.
