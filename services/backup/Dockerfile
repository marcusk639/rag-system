# Nightly backup cron service for the TWK KB database.
#
# Base is postgres:16 to guarantee the pg_dump MAJOR version matches the server
# (production is 16.14). A pg_dump older than the server refuses to run; a
# newer one produces a dump the older server may not restore. Pin this image
# when production Postgres is upgraded.
#
# Debian rather than Alpine on purpose: azcopy ships a glibc binary and will
# not run on musl.
FROM postgres:16

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  age \
  jq \
  awscli \
  && rm -rf /var/lib/apt/lists/* \
  # aka.ms/downloadazcopy-v10-linux serves an amd64 binary unconditionally.
  # Railway builds amd64, but an Apple Silicon workstation does not — and an
  # amd64 azcopy on arm64 dies with SIGTRAP (exit 133) at build time. Resolve
  # the arch from dpkg rather than buildkit's TARGETARCH so this holds however
  # the image is built.
  && case "$(dpkg --print-architecture)" in \
  amd64) AZCOPY_URL=https://aka.ms/downloadazcopy-v10-linux ;; \
  arm64) AZCOPY_URL=https://aka.ms/downloadazcopy-v10-linux-arm64 ;; \
  *) echo "unsupported arch: $(dpkg --print-architecture)" >&2; exit 1 ;; \
  esac \
  && curl -sSL "$AZCOPY_URL" \
  | tar -xz --strip-components=1 -C /usr/local/bin --wildcards '*/azcopy' \
  && chmod +x /usr/local/bin/azcopy \
  && azcopy --version

# Path is repo-root-relative: Railway builds this from the repo root, the same
# as apps/*/Dockerfile. Building from inside services/backup/ will not work.
COPY services/backup/backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# azcopy writes plan/log files; give it a writable home.
ENV AZCOPY_LOG_LOCATION=/tmp/azcopy-logs
ENV AZCOPY_JOB_PLAN_LOCATION=/tmp/azcopy-plans

# No ENTRYPOINT override: the postgres base image's entrypoint would try to
# initialise a database. CMD alone is not enough — reset it explicitly.
ENTRYPOINT []
CMD ["/usr/local/bin/backup.sh"]
