#!/bin/bash
# Self-hosted GitHub Actions runners for the Try-Pennie org, on this Mac, while
# GitHub's own runners are refused for billing (since 2026-10-23).
#
# Everything runs as a hidden service user, cirunner, that has no password and
# cannot log in, so a job can read nothing in Dan's home. Docker for the jobs is
# cirunner's own Colima VM, which mounts only /Users/cirunner.
#
# Kept in Slate's repo as scripts/mac-runner/setup.sh; Dan's copy is
# ~/pennie-ci-runner/setup.sh. Run one stage at a time, with sudo:
#
#   sudo bash ~/pennie-ci-runner/setup.sh user      creates the cirunner user
#   sudo bash ~/pennie-ci-runner/setup.sh docker    starts cirunner's Docker and proves it answers
#   sudo bash ~/pennie-ci-runner/setup.sh runners   asks for the registration token, registers two runners
#   sudo bash ~/pennie-ci-runner/setup.sh refresh   rewrites each runner's settings and restarts it (no token)
#   sudo bash ~/pennie-ci-runner/setup.sh status    shows what is installed and running
#   sudo bash ~/pennie-ci-runner/setup.sh stop      stops runners and Docker (they start again on the next "start")
#   sudo bash ~/pennie-ci-runner/setup.sh start     starts them again
#   sudo bash ~/pennie-ci-runner/setup.sh remove    stops and deletes everything, the user included
#
# Going back to GitHub's runners does not need this script: set the org
# variable PENNIE_CI_RUNNER to github and every repo's jobs run on GitHub again.

set -euo pipefail

RUNNER_USER=cirunner
RUNNER_HOME=/Users/$RUNNER_USER
ORG_URL=https://github.com/Try-Pennie
RUNNER_VERSION=2.338.1
RUNNER_SHA256=52c3fb801b931fbd454979bae5ec3443ea3da2c4a1b4c44fa546fb630d61a0a9
RUNNER_TARBALL=actions-runner-osx-arm64-$RUNNER_VERSION.tar.gz
RUNNER_URL=https://github.com/actions/runner/releases/download/v$RUNNER_VERSION/$RUNNER_TARBALL
# Two runners, not three: the disk had 33 GB free on 2026-10-24, and each runner
# keeps its own checkouts of Slate, Bidspoke and PET. Only mac-1 can reach Docker,
# so two Docker jobs (each starting a local Supabase on the same ports) never overlap.
RUNNERS=(mac-1 mac-2)
DOCKER_RUNNER=mac-1
LABEL=pennie-mac
DOCKER_SOCK=$RUNNER_HOME/.colima/default/docker.sock
PATH_FOR_JOBS=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
DAEMON_DIR=/Library/LaunchDaemons
# Every job checks free disk before it starts (the runner's job started hook) and
# fails, saying why, below this many GB. The runners share Dan's work disk, and on
# 2026-10-24 their first runs used about 10 GB in half an hour.
MIN_FREE_GB=10
DISK_GUARD=$RUNNER_HOME/runners/disk-guard.sh
COLIMA_PLIST=$DAEMON_DIR/com.trypennie.ci-colima.plist

die() { echo "FAILED: $*" >&2; exit 1; }
need_root() { [ "$(id -u)" = 0 ] || die "run this with sudo"; }
user_exists() { dscl . -read "/Users/$RUNNER_USER" UniqueID >/dev/null 2>&1; }
as_runner() { sudo -u "$RUNNER_USER" env HOME="$RUNNER_HOME" PATH="$PATH_FOR_JOBS" "$@"; }
runner_plist() { echo "$DAEMON_DIR/com.trypennie.ci-runner.$1.plist"; }

# The runner user is in the staff group, like every local user, so a home folder
# left at macOS's default (group may enter) is readable by every job.
home_is_private() {
  local owner=${SUDO_USER:-}
  [ -n "$owner" ] || return 0
  ! as_runner ls "/Users/$owner" >/dev/null 2>&1
}

# Tools a job takes for granted because GitHub's ubuntu image ships them. On the
# Mac they come from Homebrew (brew install colima docker awscli jq gh), and a job
# missing one fails as "command not found" partway through, so they are checked.
JOB_TOOLS=(git curl tar python3 node jq gh aws docker colima)
missing_tools() {
  local t out=""
  for t in "${JOB_TOOLS[@]}"; do PATH=$PATH_FOR_JOBS command -v "$t" >/dev/null 2>&1 || out="$out $t"; done
  echo "${out# }"
}

write_daemon() { # path label workdir home log program args...
  local path=$1 label=$2 workdir=$3 home=$4 log=$5; shift 5
  local args=""
  for a in "$@"; do args="$args<string>$a</string>"; done
  cat >"$path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>UserName</key><string>$RUNNER_USER</string>
  <key>GroupName</key><string>staff</string>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$home</string>
    <key>PATH</key><string>$PATH_FOR_JOBS</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$log</string>
  <key>StandardErrorPath</key><string>$log</string>
</dict></plist>
PLIST
  chown root:wheel "$path"
  chmod 644 "$path"
  plutil -lint "$path" >/dev/null || die "$path is not a valid plist"
}

load_daemon() { launchctl bootout system "$1" 2>/dev/null || true; launchctl bootstrap system "$1"; }
unload_daemon() { [ -f "$1" ] && launchctl bootout system "$1" 2>/dev/null || true; }

stage_user() {
  need_root
  if user_exists; then echo "OK: $RUNNER_USER already exists"; return; fi
  local uid=550
  while dscl . -search /Users UniqueID "$uid" | grep -q .; do uid=$((uid + 1)); done
  dscl . -create "/Users/$RUNNER_USER"
  dscl . -create "/Users/$RUNNER_USER" RealName "CI runner"
  dscl . -create "/Users/$RUNNER_USER" UniqueID "$uid"
  dscl . -create "/Users/$RUNNER_USER" PrimaryGroupID 20
  dscl . -create "/Users/$RUNNER_USER" UserShell /bin/zsh
  dscl . -create "/Users/$RUNNER_USER" NFSHomeDirectory "$RUNNER_HOME"
  dscl . -create "/Users/$RUNNER_USER" IsHidden 1
  # A star is no password at all: nobody can log in as this user, only launchd runs it.
  dscl . -create "/Users/$RUNNER_USER" Password '*'
  mkdir -p "$RUNNER_HOME"
  chown "$RUNNER_USER":staff "$RUNNER_HOME"
  chmod 700 "$RUNNER_HOME"
  user_exists || die "the user was not created"
  echo "OK: created $RUNNER_USER (uid $uid), hidden, no login"
}

stage_docker() {
  need_root
  user_exists || die "run the user stage first"
  [ -x /opt/homebrew/bin/colima ] || die "Colima is not installed (brew install colima docker)"
  write_daemon "$COLIMA_PLIST" com.trypennie.ci-colima "$RUNNER_HOME" "$RUNNER_HOME" "$RUNNER_HOME/colima.log" \
    /opt/homebrew/bin/colima start --foreground --vm-type vz --cpu 4 --memory 6 --disk 25 \
    --mount "$RUNNER_HOME:w"
  load_daemon "$COLIMA_PLIST"
  echo "Starting cirunner's Docker (the first start downloads a VM image, a few minutes)..."
  local i
  for i in $(seq 1 60); do
    if as_runner docker --host "unix://$DOCKER_SOCK" info >/dev/null 2>&1; then
      echo "OK: cirunner's Docker answers"
      as_runner docker --host "unix://$DOCKER_SOCK" run --rm hello-world >/dev/null 2>&1 \
        && echo "OK: a test container ran" || die "Docker answers but a container would not run (log: $RUNNER_HOME/colima.log)"
      return
    fi
    sleep 5
  done
  echo "--- last lines of $RUNNER_HOME/colima.log:" >&2
  tail -20 "$RUNNER_HOME/colima.log" >&2 || true
  die "cirunner's Docker did not answer within 5 minutes"
}

# Each runner gets its OWN home folder. Shared, two jobs at once collided on
# 2026-10-24: pnpm/action-setup installs pnpm into $HOME/setup-pnpm, and the two
# runners' installs deleted each other's files mid job (PR #4208's first run).
# The pnpm store, Playwright's browsers and every other per user cache follow HOME.
runner_home() { echo "$RUNNER_HOME/runners/$1/home"; }

write_disk_guard() {
  # Owned by root, so a job (running as cirunner) cannot edit its own check away.
  mkdir -p "$RUNNER_HOME/runners"
  cat >"$DISK_GUARD" <<GUARD
#!/bin/bash
free_kb=\$(df -k / | awk 'NR==2 {print \$4}')
if [ -z "\$free_kb" ] || [ "\$free_kb" -lt $((MIN_FREE_GB * 1024 * 1024)) ]; then
  echo "::error title=The Mac runner's disk is nearly full::\$((\${free_kb:-0} / 1024 / 1024)) GB free, under the $MIN_FREE_GB GB floor, so this job did not start. Free space on Dan's work MacBook, then re-run."
  exit 1
fi
GUARD
  chown root:wheel "$DISK_GUARD"
  chmod 755 "$DISK_GUARD"
}

write_runner_settings() { # name
  local name=$1 dir=$RUNNER_HOME/runners/$1 home
  home=$(runner_home "$1")
  write_disk_guard
  as_runner mkdir -p "$home"
  echo "$PATH_FOR_JOBS" | as_runner tee "$dir/.path" >/dev/null
  {
    echo "HOME=$home"
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$DISK_GUARD"
    [ "$name" = "$DOCKER_RUNNER" ] && echo "DOCKER_HOST=unix://$DOCKER_SOCK"
    true
  } | as_runner tee "$dir/.env" >/dev/null
  write_daemon "$(runner_plist "$name")" "com.trypennie.ci-runner.$name" "$dir" "$home" "$dir/launchd.log" "$dir/run.sh"
}

stage_runners() {
  need_root
  user_exists || die "run the user stage first"
  [ -f "$COLIMA_PLIST" ] || die "run the docker stage first"
  [ -z "$(missing_tools)" ] || die "jobs would lack: $(missing_tools) (brew install them first)"
  home_is_private || die "$RUNNER_USER can read /Users/$SUDO_USER; run chmod 700 ~ as yourself first"
  local tmp; tmp=$(mktemp -d /tmp/pennie-runner.XXXXXX)
  echo "Downloading runner $RUNNER_VERSION..."
  curl -fsSL -o "$tmp/$RUNNER_TARBALL" "$RUNNER_URL"
  echo "$RUNNER_SHA256  $tmp/$RUNNER_TARBALL" | shasum -a 256 -c - >/dev/null || die "the download's checksum does not match"
  chmod 755 "$tmp"; chmod 644 "$tmp/$RUNNER_TARBALL"
  echo
  echo "Paste the registration token from GitHub's New runner page, then press Return."
  echo "(It is the value after --token in the Configure box. Nothing shows as you paste.)"
  local token; read -rs token; echo
  [ -n "$token" ] || die "no token was pasted"
  local name dir labels
  for name in "${RUNNERS[@]}"; do
    dir=$RUNNER_HOME/runners/$name
    labels=$LABEL
    [ "$name" = "$DOCKER_RUNNER" ] && labels=$LABEL,$LABEL-docker
    as_runner mkdir -p "$dir"
    as_runner tar xzf "$tmp/$RUNNER_TARBALL" -C "$dir"
    (cd "$dir" && as_runner ./config.sh --unattended --url "$ORG_URL" --token "$token" \
      --name "dan-macbook-$name" --labels "$labels" --runnergroup Default --work _work --replace) \
      || die "registering $name failed (an expired token is the usual cause: it lasts an hour)"
    write_runner_settings "$name"
    load_daemon "$(runner_plist "$name")"
    echo "OK: registered and started dan-macbook-$name (labels: $labels)"
  done
  token=""
  rm -rf "$tmp"
}

stage_refresh() {
  need_root
  user_exists || die "run the user stage first"
  local name
  for name in "${RUNNERS[@]}"; do
    [ -f "$RUNNER_HOME/runners/$name/.runner" ] || die "$name is not registered; run the runners stage"
    write_runner_settings "$name"
    # A job running now finishes first: launchd stops the listener, which hands
    # an in progress job back as failed, so only refresh between runs.
    load_daemon "$(runner_plist "$name")"
    echo "OK: $name now uses $(runner_home "$name") and was restarted"
  done
  # The shared folder the collision happened in is no longer used.
  rm -rf "$RUNNER_HOME/setup-pnpm"
}

stage_status() {
  user_exists && echo "user: $RUNNER_USER exists" || echo "user: missing"
  local p
  for p in "$COLIMA_PLIST" $(for n in "${RUNNERS[@]}"; do runner_plist "$n"; done); do
    if [ -f "$p" ]; then
      # Judged by grep's own exit, not the pipeline's last command, so an
      # installed daemon launchd does not know about says so.
      local state
      if state=$(launchctl print "system/$(basename "$p" .plist)" 2>/dev/null | grep -m1 -E "state ="); then
        echo "$(basename "$p" .plist):$state"
      else
        echo "$(basename "$p" .plist): installed, not loaded"
      fi
    else
      echo "$(basename "$p" .plist): not installed"
    fi
  done
  if [ "$(id -u)" = 0 ] && user_exists; then
    as_runner docker --host "unix://$DOCKER_SOCK" info >/dev/null 2>&1 && echo "docker: answers" || echo "docker: not answering"
    home_is_private && echo "your home folder: private from $RUNNER_USER" || echo "your home folder: READABLE by $RUNNER_USER (run chmod 700 ~)"
  fi
  local m; m=$(missing_tools)
  [ -z "$m" ] && echo "job tools: all present" || echo "job tools: MISSING $m"
  df -h / | tail -1 | awk '{print "disk free: " $4}'
}

stage_stop() {
  need_root
  local n
  for n in "${RUNNERS[@]}"; do unload_daemon "$(runner_plist "$n")"; done
  unload_daemon "$COLIMA_PLIST"
  echo "OK: stopped. Queued jobs wait until you run the start stage."
}

stage_start() {
  need_root
  load_daemon "$COLIMA_PLIST"
  local n
  for n in "${RUNNERS[@]}"; do load_daemon "$(runner_plist "$n")"; done
  echo "OK: started"
}

stage_remove() {
  need_root
  stage_stop
  rm -f "$COLIMA_PLIST"
  local n
  for n in "${RUNNERS[@]}"; do rm -f "$(runner_plist "$n")"; done
  if user_exists; then
    as_runner /opt/homebrew/bin/colima delete --force >/dev/null 2>&1 || true
    dscl . -delete "/Users/$RUNNER_USER"
  fi
  rm -rf "$RUNNER_HOME"
  echo "OK: removed. Delete the dan-macbook-mac-* runners on GitHub's org Runners page too."
}

case "${1:-}" in
  user) stage_user ;;
  docker) stage_docker ;;
  runners) stage_runners ;;
  refresh) stage_refresh ;;
  status) stage_status ;;
  stop) stage_stop ;;
  start) stage_start ;;
  remove) stage_remove ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
