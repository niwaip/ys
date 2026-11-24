# Fixed read-only local Docker image SBOM generator. No pull, sudo or install.
set -eu
export LC_ALL=C
PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH
unset DOCKER_CONFIG
image_id=${1:?Usage: sh image-sbom.sh sha256:FULL_IMAGE_ID}
case "$image_id" in sha256:*) ;; *) echo 'Full Docker ImageID required' >&2; exit 2;; esac
hex=${image_id#sha256:}
case "$hex" in *[!a-f0-9]*) exit 2;; esac
[ "${#hex}" -eq 64 ] || exit 2
command -v docker >/dev/null || { echo 'Docker unavailable' >&2; exit 127; }
command -v trivy >/dev/null || { echo 'Trivy unavailable on target; use offline generation or install through administrator' >&2; exit 127; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
export DOCKER_CONFIG="$work/docker-config"
mkdir "$DOCKER_CONFIG"
# Only explicitly selected safe inspect fields; never export Config.Env.
docker --host unix:///var/run/docker.sock image inspect --format '{"imageId":{{json .Id}},"architecture":{{json .Architecture}},"os":{{json .Os}},"repoTags":{{json .RepoTags}},"repoDigests":{{json .RepoDigests}}}' "$image_id" > "$work/image.json"
# A disposable cache avoids mutating the host's Trivy cache/database.
export TRIVY_CACHE_DIR="$work/cache"
export TRIVY_DOCKER_HOST=unix:///var/run/docker.sock
export TRIVY_DISABLE_TELEMETRY=true
trivy image --image-src docker --format cyclonedx --skip-db-update --skip-java-db-update --offline-scan --timeout 3m --output "$work/sbom.json" "$image_id" >/dev/null
[ "$(wc -c < "$work/sbom.json")" -le 20000000 ] || { echo 'SBOM exceeds 20000000 bytes' >&2; exit 3; }
emit() { printf '%s|' "$1"; base64 < "$2" | tr -d '\n'; printf '\n'; }
uname -n > "$work/host"
(cat /etc/machine-id 2>/dev/null || true) > "$work/machine"
(cat /sys/class/dmi/id/product_serial 2>/dev/null || true) > "$work/serial"
date -u +%Y-%m-%dT%H:%M:%SZ > "$work/time"
trivy --version | head -1 > "$work/tool"
emit YS_IMAGE "$work/image.json"
emit YS_HOST "$work/host"
emit YS_MACHINE "$work/machine"
emit YS_SERIAL "$work/serial"
emit YS_TIME "$work/time"
emit YS_TOOL "$work/tool"
emit YS_SBOM "$work/sbom.json"
