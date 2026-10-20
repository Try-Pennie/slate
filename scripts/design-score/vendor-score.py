#!/usr/bin/env python3
"""vendor-score.py: the design match score's tools, copied into an app's own repository so the score
runs in that app's CI, and the check that the copy still matches claude-config's (claude-config#1385).

    python3 ~/.claude/skills/design-rounds/score/vendor-score.py copy <folder> [--from <score folder>]
    python3 <folder>/vendor-score.py check <folder> [--against <score folder>]

Dan's decision, 2026-10-20: Slate COPIES the score tools into its repository, since its CI has no
~/.claude, with a check that they still match claude-config's copy.

COPY writes every file the score needs, flat in one folder (capture-web.mjs, design_score.py and the
helpers it imports, including design_file.py from the design rounds skill one folder up, the shared
Playwright's settings, and this tool itself), then vendor-manifest.json: the sha256 of each file as
claude-config had it. It copies from the folder this script is in, or from --from, which must be
claude-config's own copy (the score folder with design_file.py one folder up), never another vendored
copy. A file in the folder that is not part of the copy is left alone and named.

CHECK compares the copy two ways, and says which it did:
  1. against its own manifest, always. This needs nothing but the folder, so it runs in the app's CI,
     and it catches a vendored file edited by hand, deleted, or joined by one that is not part of the
     copy, and a manifest that leaves out a file the score needs.
  2. against claude-config's current copy, wherever that is on disk: --against, or the installed
     ~/.claude/skills/design-rounds/score when nothing is named. This catches claude-config having
     moved on since the copy was made, which the manifest cannot see (it was written from the same
     files). Where no copy is on the machine, as in CI, it says it did not compare, and the manifest
     alone decides.
CI deliberately does not fetch claude-config from GitHub to compare: every change to the score in
claude-config would then turn the app's next unrelated pull request red, and a build left red for a
reason nobody on that pull request can fix stops being read (L538). Refreshing the copy is a
deliberate change in the app, made where claude-config is on disk, with the command the check prints.

Exit codes: 0 matches; 1 drift (every differing, missing or extra file named, and the command that
refreshes the copy printed); 2 could not check (no folder, no or unreadable manifest, a --from or
--against that is not claude-config's copy, bad arguments).
"""
import hashlib
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = "vendor-manifest.json"
FORMAT = "design-score-vendor"
VERSION = 1
# Each vendored file, and where it sits relative to claude-config's score folder.
FILES = {
    "capture-web.mjs": "capture-web.mjs",
    "design_score.py": "design_score.py",
    "pngio.py": "pngio.py",
    "score_github.py": "score_github.py",
    "design_file.py": os.path.join("..", "design_file.py"),
    "shared-playwright.json": "shared-playwright.json",
    "vendor-score.py": "vendor-score.py",
}
INSTALLED = os.path.join("~", ".claude", "skills", "design-rounds", "score")
USAGE = ("usage: vendor-score.py copy <folder> [--from <claude-config score folder>]\n"
         "       vendor-score.py check <folder> [--against <claude-config score folder>]")


def say(msg):
    print("vendor-score: " + msg)


def sha(path):
    with open(path, "rb") as fh:
        return "sha256:" + hashlib.sha256(fh.read()).hexdigest()


def refresh_command(folder):
    return "python3 %s/vendor-score.py copy %s" % (INSTALLED, folder)


def sources(score_dir):
    return {name: os.path.normpath(os.path.join(score_dir, rel)) for name, rel in FILES.items()}


def is_claude_config_copy(score_dir):
    """claude-config's own score folder: every source in place, design_file.py one folder up, and no
    manifest (which only a vendored copy carries)."""
    if not os.path.isdir(score_dir) or os.path.exists(os.path.join(score_dir, MANIFEST)):
        return False
    return all(os.path.isfile(p) for p in sources(score_dir).values())


def write_atomic(path, data):
    tmp = path + ".tmp-%d" % os.getpid()
    with open(tmp, "wb") as fh:
        fh.write(data)
    os.replace(tmp, path)


def copy(folder, from_dir):
    src = os.path.abspath(from_dir or HERE)
    if not is_claude_config_copy(src):
        say("%s is not claude-config's copy of the score (its files with design_file.py one folder up, and no "
            "manifest), so there is nothing to copy from. Run copy from claude-config's copy, %s/vendor-score.py, "
            "or name it with --from <claude-config's payload/skills/design-rounds/score>." % (src, INSTALLED))
        return 2
    os.makedirs(folder, exist_ok=True)
    hashes = {}
    for name, path in sources(src).items():
        with open(path, "rb") as fh:
            data = fh.read()
        write_atomic(os.path.join(folder, name), data)
        hashes[name] = "sha256:" + hashlib.sha256(data).hexdigest()
    # The manifest last, so a copy that stopped partway is caught by the next check. It carries no
    # path from this Mac: it is committed in another repository.
    manifest = {
        "format": FORMAT, "version": VERSION,
        "from": "claude-config payload/skills/design-rounds/score (design_file.py from design-rounds)",
        "copiedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "refresh": "python3 %s/vendor-score.py copy <this folder>" % INSTALLED,
        "files": dict(sorted(hashes.items())),
    }
    write_atomic(os.path.join(folder, MANIFEST), (json.dumps(manifest, indent=1) + "\n").encode())
    say("copied %d files into %s and wrote %s. Commit the folder." % (len(hashes), folder, MANIFEST))
    extra = sorted(set(os.listdir(folder)) - set(FILES) - {MANIFEST})
    if extra:
        say("left alone, and not part of the copy (check calls them drift): %s" % ", ".join(extra))
    return 0


def check(folder, against):
    if not os.path.isdir(folder):
        say("%s is not a folder, so there is no copy to check" % folder)
        return 2
    mpath = os.path.join(folder, MANIFEST)
    if not os.path.isfile(mpath):
        say("%s has no %s, so it cannot be checked. Write the copy with: %s" % (folder, MANIFEST, refresh_command(folder)))
        return 2
    try:
        with open(mpath) as fh:
            man = json.load(fh)
    except (OSError, ValueError) as e:
        say("%s could not be read (%s), so the copy cannot be checked" % (mpath, e))
        return 2
    if not isinstance(man, dict) or man.get("format") != FORMAT or man.get("version") != VERSION \
            or not isinstance(man.get("files"), dict):
        say("%s is not a version %d %s manifest, so the copy cannot be checked" % (mpath, VERSION, FORMAT))
        return 2

    upstream = None
    if against:
        upstream = os.path.abspath(against)
        if not is_claude_config_copy(upstream):
            say("--against %s is not claude-config's copy of the score (its files with design_file.py one folder "
                "up), so the copy cannot be compared with it" % against)
            return 2
    else:
        installed = os.path.expanduser(INSTALLED)
        if is_claude_config_copy(installed):
            upstream = installed

    listed = man["files"]
    drift = []
    for name in sorted(set(FILES) | set(listed)):
        path = os.path.join(folder, name)
        if name not in FILES:
            drift.append("%s is in the manifest but is not part of the score's copy" % name)
        elif name not in listed:
            drift.append("%s is not in the manifest, and the score needs it" % name)
        if not os.path.isfile(path):
            if name in FILES:
                drift.append("%s is missing" % name)
        elif name in listed and sha(path) != listed[name]:
            drift.append("%s differs from its manifest (changed since it was copied)" % name)
    for name in sorted(set(os.listdir(folder)) - set(FILES) - {MANIFEST}):
        drift.append("%s is in the folder but is not part of the copy" % name)
    if drift:
        say("%s differs from its manifest:" % folder)
        for line in drift:
            print("  " + line)
    else:
        say("%s matches its manifest (%d files)" % (folder, len(FILES)))

    moved = []
    if upstream:
        for name, path in sources(upstream).items():
            if listed.get(name) and sha(path) != listed[name]:
                moved.append("%s changed in claude-config since it was copied" % name)
        if moved:
            say("claude-config's copy at %s has moved on:" % upstream)
            for line in moved:
                print("  " + line)
        else:
            say("matches claude-config's copy at %s" % upstream)
    else:
        say("not compared with claude-config's copy: none is on this machine (expected in CI). Compare it on a "
            "Mac with ~/.claude, or name one with --against.")

    if drift or moved:
        say("refresh the copy with: %s" % refresh_command(folder))
        return 1
    return 0


def main(argv):
    args = argv[1:]
    if len(args) < 2 or args[0] not in ("copy", "check"):
        print(USAGE)
        return 2
    cmd, folder, rest = args[0], args[1], args[2:]
    opt = {"copy": "--from", "check": "--against"}[cmd]
    value = None
    while rest:
        if rest[0] == opt and len(rest) > 1:
            value = rest[1]
            rest = rest[2:]
        else:
            print("unknown argument %s\n%s" % (rest[0], USAGE))
            return 2
    try:
        return copy(folder, value) if cmd == "copy" else check(folder, value)
    except OSError as e:
        say("could not %s %s: %s" % (cmd, folder, e))
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
