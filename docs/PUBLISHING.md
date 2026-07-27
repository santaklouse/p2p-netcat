# Publishing p2p-netcat to npm

[Русский](PUBLISHING.RU.md) | **English**

The repository produces three public, unscoped npm packages:

| Package | Version | Contents |
|---|---:|---|
| `p2p-netcat-core` | `0.4.0` | Browser-safe protocol, private pairing, native WebRTC, route records, and PTY primitives |
| `p2p-netcat` | `3.2.0` | Node.js CLI plus `p2p-netcat/core` and `p2p-netcat/relay` entrypoints |
| `p2p-netcat-web` | `0.5.0` | Prebuilt static PWA with private pairing in the package `dist` directory |

The GitHub source repository is
[`santaklouse/p2p-netcat`](https://github.com/santaklouse/p2p-netcat).

## Requirements

- Node.js 22.13 or newer;
- an npm account with 2FA enabled, or a granular token allowed to publish;
- write access to all three package names;
- the npm registry set to `https://registry.npmjs.org/`.

Authenticate and verify the active account:

```bash
npm config set registry https://registry.npmjs.org/
npm login --auth-type=web
npm whoami
```

The expected account is `santaklouse`.

## Release verification

Run all checks from the repository root:

```bash
npm ci
npm run lint
npm test

npm --prefix web ci
npm --prefix web run lint
npm --prefix web test

npm pack ./packages/core --dry-run
npm pack . --dry-run
npm pack ./web --dry-run
```

Inspect the three file lists printed by `npm pack`. They must not contain
private keys, npm tokens, development caches, or `node_modules`.

## Publish order

Publish the dependency first, then its consumers:

```bash
npm publish ./packages/core --access public
npm publish . --access public
npm publish ./web --access public
```

The package `p2p-netcat` was completely unpublished on July 20, 2026. npm
blocks reuse of the name for 24 hours, and an already-used `name@version` can
never be reused. Version `3.2.0` adds the language-neutral private pairing
protocol above the native WebRTC transport.

The web package publishes only its prebuilt `dist`, README files, license, and
package metadata. Its build dependencies remain development-only and are not
installed for users of the static artifact.

## Verify the registry

```bash
npm view p2p-netcat-core version dist-tags.latest maintainers --json
npm view p2p-netcat version dist-tags.latest maintainers --json
npm view p2p-netcat-web version dist-tags.latest maintainers --json
```

Perform a clean installation in a temporary directory:

```bash
release_test_dir="$(mktemp -d)"
npm install --prefix "${release_test_dir}" \
  p2p-netcat-core@0.4.0 \
  p2p-netcat@3.2.0 \
  p2p-netcat-web@0.5.0
"${release_test_dir}/node_modules/.bin/p2p-nc" --version
test -f "${release_test_dir}/node_modules/p2p-netcat-web/dist/index.html"
```

Expected CLI output:

```text
3.2.0
```

## Future releases

Never unpublish a normal release to correct it. Increment the appropriate
package version, rerun all checks, and publish the new immutable version.
Publish `p2p-netcat-core` first whenever the CLI or web build depends on a new
core release.

After the initial manual release, configure npm trusted publishing for the
GitHub repository instead of storing a long-lived npm token in GitHub Actions.
