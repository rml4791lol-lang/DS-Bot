#!/bin/sh
# Installs everything a checkout that has never installed anything needs to build and test.
#
#   sh scripts/setup.sh
#
# Three installs, all from the lockfiles:
#   ds-bot/node_modules   the build tools (esbuild), for client.js and link.js
#   link/node_modules     the phone link's packages; build-link.mjs bundles ../link/src
#   ds-bot/dev/harness    the DSH packages the unit tests and the linter load
#
# ds-bot/package.json's allowScripts pins esbuild's postinstall, so npm ci runs it rather than
# leaving it unreviewed (npm 11.20 and later warn about that and skip it). Repeating the script
# is safe: npm ci rebuilds the two node_modules trees from their lockfiles.
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"

echo "setup: ds-bot packages"
(cd ds-bot && npm ci --no-fund --no-audit)

echo "setup: phone link packages"
npm ci --no-fund --no-audit --prefix link

echo "setup: DSH test harness packages"
(cd ds-bot && npm run harness)

echo "setup: done"
