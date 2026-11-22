#!/usr/bin/env bash
# Build an RPM for Nook. Requires rpmbuild (Fedora/RHEL/openSUSE).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f nook-linux-x64 ]; then
  echo "Run 'npm run build:linux' first."
  exit 1
fi

mkdir -p ~/rpmbuild/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
cp nook-linux-x64 ~/rpmbuild/SOURCES/
cp packaging/nook.desktop ~/rpmbuild/SOURCES/
cp public/assets/nook-icon.png ~/rpmbuild/SOURCES/
cp packaging/nook.spec ~/rpmbuild/SPECS/

rpmbuild -bb ~/rpmbuild/SPECS/nook.spec
echo "RPM written to ~/rpmbuild/RPMS/x86_64/"
