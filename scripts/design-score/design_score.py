#!/usr/bin/env python3
"""design_score.py: score a built screen against its settled design (claude-config#1364).

    python3 design_score.py score <capture folder>     score a capture, write score.json, print it
    python3 design_score.py show <score.json>          print a score file, after checking it holds
    python3 design_score.py frames <settled design>    the frames it declares, as JSON, for an adapter
    python3 design_score.py post <score.json> --repo <owner/name> --pr <number>
                                                       post it on the pull request and on its
                                                       milestone's Match the settled design issue

Dan, 2026-10-19: "you'd know you're done not when all issues are completed but instead when the
match up score is equal to each other so the designs are exactly alike." A milestone built from a
settled design is done when BOTH halves of this score are 100%:

  decisions  every decision in the design's decision map that has an automated check passes it, on
             every frame it is checked on. The map is the denominator, never the checks: a decision
             with no check is UNCHECKED and counts as not met, so deleting a check cannot raise the
             score. A decision too visual for a check says "verify": "picture" in the map and rests
             on the picture half; one proven by some other test says "verify": "elsewhere" and
             "provenBy". Both are listed every time and left out of the count.
  pictures   every frame of the design, drawn at the frame's own width, beside the build drawing
             the same fixture data. A pixel matches when no channel (R, G, B, A) differs by more
             than TOLERANCE out of 255. Area only one side has counts as different, never as
             matching. A frame is 100% only when every compared pixel matches.

A deliberate difference reaches 100% only by a new design round, or by a named exception Dan
approves, recorded in the design file in his words, which the score then skips and lists every time.

THE CAPTURE is what a platform adapter (web: a Playwright screenshot of a fixture route; SwiftUI: a
snapshot test) leaves in a folder, so the comparing and counting here are the same for both:

    capture.json
    {"format": "design-capture", "version": 1,
     "platform": "web" | "swiftui",
     "designFile": "/abs/path/docs/design/team-capacity.html",   (or relative to the folder)
     "build": "what was drawn: a URL, a test name",
     "commit": "<the build's git commit>", "dirty": false,      (uncommitted changes when drawn)
     "capturedAt": "<ISO time>",
     "frames": [{"id": "f1",
                 "designImage": "f1-design.png", "builtImage": "f1-built.png",
                 "builtError": "<why the build could not be drawn>",      (only when it could not)
                 "checks": [{"id": "D1", "ok": true, "detail": "", "threw": false}],
                 "designChecks": [...the same checks run on the design's frame...]}]}

"designChecks" is the positive control: a check the design itself fails is wrong, so the score
refuses to read it as the build's fault. An adapter that cannot run its checks on the design (a
SwiftUI test cannot run on an HTML frame) leaves it out, and the score says so.

THE DESIGN FILE carries three JSON blocks (<script type="application/json" id="...">):
  decision-map       {"decisions": [{"id", "decision", "requirement" | "noCode", "verify"?, "provenBy"?}]}
  design-frames      {"frames": [{"id": "f1", "title": "Tomorrow, light", "width": 1280, "height"?: 900}]}
                     no height: the full page, as tall as it draws
  design-exceptions  {"exceptions": [{"id": "X1", "decision": "D7" | "frame": "f3", "region"?: [x, y, w, h],
                                      "words": "Dan's own words", "date": "YYYY-MM-DD",
                                      "source": "where he said it: an issue comment or session link"}]}
                     optional; the score prints how many it skipped every time, none included

Exit codes, never read alike (L11): 0 matched (both halves 100%), 1 not matched yet, 2 no score: the
capture or design could not be read, a frame or picture is missing, a check threw or fails on the
design itself, an exception is malformed, or nothing is left to measure. Unmeasured is never 100.
The score file is written in all three cases whenever the folder exists, with "verdict" saying which.
"""
import hashlib
import json
import math
import os
import re
import subprocess
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
# No __pycache__ beside the helpers: an app keeps a checked copy of this folder (vendor-score.py), and
# a folder the score itself wrote into would no longer match its manifest (claude-config#1385).
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import pngio  # noqa: E402
from design_file import find_blocks  # noqa: E402

# Out of 255 per channel. Measured in Slate's first trial of this score (#3934, 2026-10-19): with
# both sides drawn by the same Chrome, 8 absorbs rounding, while 24 let a blank white page match
# Slate's beige page (15 levels apart) at 97%.
TOLERANCE = 8
CAPTURE_FORMAT = "design-capture"
SCORE_FORMAT = "design-score"
VERSION = 1
VERIFY = ("check", "picture", "elsewhere")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Diff picture colours: a differing pixel, area only one side has, and an excepted region.
RED = b"\xff\x00\x00\xff"
MAGENTA = b"\xff\x00\xff\xff"
EXCEPTED = b"\xb4\xd2\xf0\xff"
# A matching pixel is drawn faded toward white, so the differences stand out against the screen.
FADE = bytes(255 - (255 - v) // 4 for v in range(256))


class Unreadable(Exception):
    """Something the score cannot be computed without could not be read."""


def pct(fraction, whole):
    """100% only when whole; otherwise rounded DOWN to a tenth, so 99.99% never reads as 100%."""
    if whole:
        return "100%"
    return "%.1f%%" % (math.floor(fraction * 1000) / 10)


def _load_json(path, what):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except OSError as err:
        raise Unreadable("%s %s could not be read (%s)" % (what, path, err.strerror or err))
    except ValueError as err:
        raise Unreadable("%s %s is not JSON (%s)" % (what, path, err))


def read_design(path, frames_only=False):
    """The design's decision map, frames and exceptions, each checked for shape; with frames_only,
    the frames alone."""
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as err:
        raise Unreadable("the design file %s could not be read (%s)" % (path, err.strerror or err))
    source = raw.decode("utf-8", errors="replace")
    blocks = find_blocks(source, ["decision-map", "design-frames", "design-exceptions"])

    def one(block_id, required):
        found = blocks[block_id]
        if not found:
            if required:
                raise Unreadable("the design file %s holds no <script type=\"application/json\" id=\"%s\"> block"
                                 % (path, block_id))
            return None
        if len(found) > 1:
            raise Unreadable("the design file %s holds %d %s blocks; keep one" % (path, len(found), block_id))
        try:
            return json.loads(found[0])
        except ValueError as err:
            raise Unreadable("the %s block in %s is not JSON (%s)" % (block_id, path, err))

    fblock = one("design-frames", True)
    frames = fblock.get("frames") if isinstance(fblock, dict) else None
    if not isinstance(frames, list) or not frames:
        raise Unreadable("the design-frames block in %s lists no frames" % path)
    fseen = set()
    for n, f in enumerate(frames, 1):
        fid = f.get("id") if isinstance(f, dict) else None
        if not isinstance(fid, str) or not fid.strip():
            raise Unreadable("frame %d in the design-frames block has no id" % n)
        if fid in fseen:
            raise Unreadable("two frames in the design-frames block share the id %s" % fid)
        fseen.add(fid)
        w = f.get("width")
        if not isinstance(w, int) or isinstance(w, bool) or w <= 0:
            raise Unreadable("frame %s in the design-frames block has no width in pixels" % fid)
        h = f.get("height")
        if h is not None and (not isinstance(h, int) or isinstance(h, bool) or h <= 0):
            raise Unreadable("frame %s in the design-frames block has a height that is not a number of pixels" % fid)

    # An adapter asks for the frames alone (`frames`), and a design whose map is still being written
    # can already be drawn.
    if frames_only:
        return raw, None, frames, None

    dmap = one("decision-map", True)
    decisions = dmap.get("decisions") if isinstance(dmap, dict) else None
    if not isinstance(decisions, list) or not decisions:
        raise Unreadable("the decision-map block in %s lists no decisions" % path)
    seen = set()
    for n, d in enumerate(decisions, 1):
        did = d.get("id") if isinstance(d, dict) else None
        if not isinstance(did, str) or not did.strip():
            raise Unreadable("decision %d in the decision-map block has no id" % n)
        if did in seen:
            raise Unreadable("two decisions in the decision-map block share the id %s" % did)
        seen.add(did)

    eblock = one("design-exceptions", False)
    exceptions = []
    if eblock is not None:
        exceptions = eblock.get("exceptions") if isinstance(eblock, dict) else None
        if not isinstance(exceptions, list):
            raise Unreadable("the design-exceptions block in %s has no \"exceptions\" list" % path)
    return raw, decisions, frames, exceptions


def check_exceptions(exceptions, decisions, frames):
    """Every exception names one decision or one frame that exists, and carries Dan's record."""
    ids = {d["id"] for d in decisions}
    sizes = {f["id"]: f for f in frames}
    problems = []
    seen = set()
    for n, x in enumerate(exceptions, 1):
        if not isinstance(x, dict):
            problems.append("exception %d is not an object" % n)
            continue
        xid = x.get("id") if isinstance(x.get("id"), str) and x.get("id").strip() else "#%d" % n
        if xid in seen:
            problems.append("exception %s: two exceptions share this id" % xid)
        seen.add(xid)
        for field in ("words", "date", "source"):
            v = x.get(field)
            if not isinstance(v, str) or not v.strip():
                problems.append("exception %s has no %s: an exception stands only on Dan's own words, dated, "
                                "with where he said them" % (xid, field))
        if isinstance(x.get("date"), str) and x.get("date").strip() and not DATE.match(x["date"]):
            problems.append("exception %s has the date %r; write it as YYYY-MM-DD" % (xid, x["date"]))
        has_d, has_f = "decision" in x, "frame" in x
        if has_d == has_f:
            problems.append("exception %s must name exactly one decision or one frame" % xid)
            continue
        named = x["decision"] if has_d else x["frame"]
        if not isinstance(named, str):
            problems.append("exception %s names its %s as %s; write the %s's id as text"
                            % (xid, "decision" if has_d else "frame", json.dumps(named)[:80],
                               "decision" if has_d else "frame"))
            continue
        if has_d:
            if x["decision"] not in ids:
                problems.append("exception %s names the decision %s, which the decision map does not hold"
                                % (xid, x["decision"]))
            if "region" in x:
                problems.append("exception %s gives a region, which only a frame exception can" % xid)
            continue
        if x["frame"] not in sizes:
            problems.append("exception %s names the frame %s, which the design does not declare" % (xid, x["frame"]))
            continue
        if "region" in x:
            r = x["region"]
            frame = sizes[x["frame"]]
            if (not isinstance(r, list) or len(r) != 4
                    or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in r)
                    or r[2] == 0 or r[3] == 0):
                problems.append("exception %s has a region that is not [x, y, width, height] in whole pixels" % xid)
            elif r[0] + r[2] > frame["width"] or ("height" in frame and r[1] + r[3] > frame["height"]):
                problems.append("exception %s has a region reaching outside its frame %s (%d wide)"
                                % (xid, x["frame"], frame["width"]))
    return problems


def compare(design, built, regions):
    """Matched and compared pixel counts, and the diff picture, for one frame.

    design and built are (width, height, rgba). regions are [x, y, w, h] left out of the count.
    """
    dw, dh, dpx = design
    bw, bh, bpx = built
    w, h = max(dw, bw), max(dh, bh)
    tol = TOLERANCE
    out = bytearray(w * h * 4)
    matched = compared = 0
    for y in range(h):
        spans = [(r[0], r[0] + r[2]) for r in regions if r[1] <= y < r[1] + r[3]]
        row_at = y * w * 4
        if not spans and dw == bw and y < dh and y < bh:
            drow = dpx[y * dw * 4:(y + 1) * dw * 4]
            brow = bpx[y * bw * 4:(y + 1) * bw * 4]
            if drow == brow:
                matched += dw
                compared += dw
                faded = bytearray(drow.translate(FADE))
                faded[3::4] = b"\xff" * dw
                out[row_at:row_at + dw * 4] = faded
                continue
        for x in range(w):
            k = row_at + x * 4
            if any(a <= x < b for a, b in spans):
                out[k:k + 4] = EXCEPTED
                continue
            compared += 1
            if x < dw and y < dh and x < bw and y < bh:
                i = (y * dw + x) * 4
                j = (y * bw + x) * 4
                if (abs(dpx[i] - bpx[j]) <= tol and abs(dpx[i + 1] - bpx[j + 1]) <= tol
                        and abs(dpx[i + 2] - bpx[j + 2]) <= tol and abs(dpx[i + 3] - bpx[j + 3]) <= tol):
                    matched += 1
                    out[k:k + 4] = bytes((FADE[dpx[i]], FADE[dpx[i + 1]], FADE[dpx[i + 2]], 255))
                else:
                    out[k:k + 4] = RED
            else:
                out[k:k + 4] = MAGENTA
    return matched, compared, (w, h, bytes(out))


def _git(directory, *args):
    try:
        proc = subprocess.run(["git", "-C", directory] + list(args), capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def score_capture(folder):
    """The score of the capture in `folder`, as the dict written to score.json."""
    s = {"format": SCORE_FORMAT, "version": VERSION, "verdict": "unmeasured", "unmeasured": [],
         "scoredAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "tolerance": TOLERANCE,
         "platform": None, "build": None, "commit": None, "dirty": None, "capturedAt": None,
         "design": None, "designFile": None, "designSha256": None,
         "decisions": {"met": 0, "of": 0, "rows": []}, "pictures": {"score": 0, "frames": []},
         "exceptions": [], "notes": []}
    no = s["unmeasured"]
    try:
        cap = _load_json(os.path.join(folder, "capture.json"), "the capture")
        if not isinstance(cap, dict) or cap.get("format") != CAPTURE_FORMAT:
            raise Unreadable("%s is not a design capture (its \"format\" is not %s)"
                             % (os.path.join(folder, "capture.json"), CAPTURE_FORMAT))
        if cap.get("version") != VERSION:
            raise Unreadable("the capture is version %r, and this score reads version %d"
                             % (cap.get("version"), VERSION))
        for key in ("platform", "build", "commit", "dirty", "capturedAt"):
            s[key] = cap.get(key)
        design_file = cap.get("designFile")
        if not isinstance(design_file, str) or not design_file:
            raise Unreadable("the capture names no \"designFile\"")
        if not os.path.isabs(design_file):
            design_file = os.path.normpath(os.path.join(folder, design_file))
        s["designFile"] = design_file
        # The hash is of the file's bytes as committed, so the close gate can compare it with the
        # design file GitHub holds at the scored commit.
        raw, decisions, frames, exceptions = read_design(design_file)
        s["designSha256"] = hashlib.sha256(raw).hexdigest()
        top = _git(os.path.dirname(design_file), "rev-parse", "--show-toplevel")
        s["design"] = os.path.relpath(os.path.realpath(design_file), os.path.realpath(top)) if top else design_file
        cframes = cap.get("frames")
        if not isinstance(cframes, list):
            raise Unreadable("the capture has no \"frames\" list")
    except Unreadable as err:
        no.append(str(err))
        return s

    problems = check_exceptions(exceptions, decisions, frames)
    if problems:
        no.extend(problems)
        return s
    s["exceptions"] = exceptions
    excepted_decisions = {x["decision"]: x for x in exceptions if "decision" in x}
    excepted_frames = {x["frame"]: x for x in exceptions if "frame" in x and "region" not in x}
    regions = {}
    for x in exceptions:
        if "frame" in x and "region" in x:
            regions.setdefault(x["frame"], []).append(x["region"])

    declared = {f["id"]: f for f in frames}
    captured = {}
    for n, cf in enumerate(cframes, 1):
        fid = cf.get("id") if isinstance(cf, dict) else None
        if not isinstance(fid, str):
            no.append("captured frame %d has no id" % n)
            continue
        if fid not in declared:
            no.append("the capture holds the frame %s, which the design does not declare" % fid)
            continue
        if fid in captured:
            no.append("the capture holds the frame %s twice" % fid)
            continue
        captured[fid] = cf

    # --- decisions ---------------------------------------------------------------------------
    by_id = {d["id"]: d for d in decisions}
    results = {}   # decision id -> [(frame, ok, detail)]
    control_missing = []
    for fid, cf in captured.items():
        for side in ("checks", "designChecks"):
            if side not in cf:
                if side == "designChecks":
                    control_missing.append(fid)
                continue
            rows = cf[side]
            if not isinstance(rows, list):
                no.append("frame %s: its %s is not a list" % (fid, side))
                continue
            for r in rows:
                if not isinstance(r, dict) or not isinstance(r.get("id"), str) or not isinstance(r.get("ok"), bool):
                    no.append("frame %s: a %s entry is not {\"id\", \"ok\", \"detail\"}: %s"
                              % (fid, side, json.dumps(r)[:120]))
                    continue
                did = r["id"]
                if did not in by_id:
                    no.append("frame %s: a check is for %s, which the decision map does not hold; the checks and "
                              "the map disagree about what was decided" % (fid, did))
                    continue
                if did in excepted_decisions:
                    continue
                detail = str(r.get("detail") or "")
                if r.get("threw"):
                    no.append("frame %s: the check for %s threw (%s) on the %s side, so it measured nothing"
                              % (fid, did, detail or "no detail", "design" if side == "designChecks" else "built"))
                    continue
                if side == "designChecks":
                    if not r["ok"]:
                        no.append("frame %s: the design fails its own check for %s (%s), so the check is wrong, "
                                  "not the build" % (fid, did, detail or "no detail"))
                    continue
                results.setdefault(did, []).append((fid, r["ok"], detail))
    if control_missing:
        s["notes"].append("checks not run against the design on %s, so they have no positive control"
                          % ", ".join(sorted(control_missing)))

    for d in decisions:
        shown = d.get("frames")
        if shown is not None and (not isinstance(shown, list) or any(f not in declared for f in shown)):
            no.append("%s says it shows on the frames %s, and the design declares %s"
                      % (d["id"], json.dumps(shown), ", ".join(declared)))

    rows = []
    met = of = 0
    for d in decisions:
        did = d["id"]
        row = {"id": did, "decision": d.get("decision", ""), "frames": []}
        verify = d.get("verify", "check")
        if did in excepted_decisions:
            row["status"] = "excepted"
            row["detail"] = "exception %s" % excepted_decisions[did].get("id")
        elif verify not in VERIFY:
            no.append("%s says \"verify\": %r, and a decision is verified by one of %s"
                      % (did, verify, ", ".join(VERIFY)))
            row["status"] = "unreadable"
        elif verify == "elsewhere" and not (isinstance(d.get("provenBy"), str) and d["provenBy"].strip()):
            no.append("%s is marked as proven elsewhere but does not say where (\"provenBy\")" % did)
            row["status"] = "unreadable"
        elif verify != "check" and did in results:
            no.append("%s is marked \"verify\": \"%s\" and also has a check; say which one holds it" % (did, verify))
            row["status"] = "unreadable"
        elif verify == "picture":
            row["status"] = "picture"
        elif verify == "elsewhere":
            row["status"] = "elsewhere"
            row["detail"] = d["provenBy"].strip()
        else:
            of += 1
            got = results.get(did, [])
            row["frames"] = [g[0] for g in got]
            fails = [g for g in got if not g[1]]
            # The frames the map says it shows on, each needing its check (a frame Dan excepted aside),
            # so a check run on one frame never stands for the others (the settled design, #1364).
            unchecked_on = [f for f in (d.get("frames") or [])
                            if f not in row["frames"] and f not in excepted_frames]
            if not got:
                row["status"] = "unchecked"
                row["detail"] = "no check ran for it on any frame"
            elif unchecked_on:
                row["status"] = "unchecked"
                row["detail"] = "no check ran for it on %s, where the map says it shows" % ", ".join(unchecked_on)
            elif fails:
                row["status"] = "unmet"
                row["detail"] = "; ".join("%s: %s" % (g[0], g[2] or "failed") for g in fails)
            else:
                row["status"] = "met"
                met += 1
        rows.append(row)
    s["decisions"] = {"met": met, "of": of, "rows": rows}
    if of == 0 and not any(r["status"] == "unreadable" for r in rows):
        no.append("no decision is left to check (every one rests on the picture half, is proven elsewhere or "
                  "is excepted), so the decision half would measure nothing")

    # --- pictures ----------------------------------------------------------------------------
    pframes = []
    for f in frames:
        fid = f["id"]
        pf = {"id": fid, "title": f.get("title", ""), "width": f["width"], "height": f.get("height"),
              "status": "unmeasured", "compared": 0, "matched": 0, "score": 0}
        pframes.append(pf)
        if fid in excepted_frames:
            pf["status"] = "excepted"
            pf["detail"] = "exception %s" % excepted_frames[fid].get("id")
            continue
        cf = captured.get(fid)
        if cf is None:
            no.append("the design's frame %s has no picture in the capture" % fid)
            continue
        if cf.get("builtError"):
            no.append("frame %s: the build could not be drawn (%s)" % (fid, cf["builtError"]))
            continue
        try:
            names = []
            for key in ("designImage", "builtImage"):
                name = cf.get(key)
                if not isinstance(name, str) or not name:
                    raise Unreadable("frame %s names no %s" % (fid, key))
                names.append(name)
            dimg = pngio.read_png(os.path.join(folder, names[0]))
            bimg = pngio.read_png(os.path.join(folder, names[1]))
        except (Unreadable, pngio.PngError) as err:
            no.append("frame %s: %s" % (fid, err))
            continue
        if dimg[0] != f["width"]:
            no.append("frame %s: the design's picture is %d wide, and the frame is declared %d wide, so it was not "
                      "drawn at the frame's own width" % (fid, dimg[0], f["width"]))
            continue
        if f.get("height") is not None and dimg[1] != f["height"]:
            no.append("frame %s: the design's picture is %d tall, and the frame is declared %d tall"
                      % (fid, dimg[1], f["height"]))
            continue
        if bimg[0] != dimg[0] and bimg[0] % dimg[0] == 0:
            s["notes"].append("frame %s: the build's picture is exactly %d times the frame's width; was it drawn at "
                              "a scale above 1?" % (fid, bimg[0] // dimg[0]))
        matched, compared, diff = compare(dimg, bimg, regions.get(fid, []))
        if compared == 0:
            no.append("frame %s: its exceptions leave no pixel to compare" % fid)
            continue
        diff_name = "%s-diff.png" % fid
        try:
            pngio.write_png(os.path.join(folder, diff_name), *diff)
        except (OSError, pngio.PngError) as err:
            s["notes"].append("frame %s: the diff picture could not be written (%s)" % (fid, err))
            diff_name = None
        pf.update({"status": "measured", "compared": compared, "matched": matched,
                   "score": matched / compared, "diff": diff_name,
                   "builtSize": [bimg[0], bimg[1]], "designSize": [dimg[0], dimg[1]]})
    measured = [p for p in pframes if p["status"] == "measured"]
    if all(p["status"] == "excepted" for p in pframes):
        no.append("every frame is excepted, so no frame is left to compare and the picture half measures nothing")
    whole = bool(measured) and all(p["matched"] == p["compared"] for p in measured)
    avg = sum(p["score"] for p in measured) / len(measured) if measured else 0
    s["pictures"] = {"score": 1 if whole else min(avg, math.nextafter(1, 0)), "frames": pframes}

    if not no:
        s["verdict"] = "matched" if (met == of and whole) else "not-matched"
    return s


def verify_score(s):
    """The verdict a score file's own rows give, and what in it cannot be read. A score file whose
    stored verdict this contradicts was not written by this score, or was edited after."""
    problems = []
    if not isinstance(s, dict) or s.get("format") != SCORE_FORMAT:
        return None, ["it is not a design score file"]
    if s.get("version") != VERSION:
        return None, ["it is version %r, and this reads version %d" % (s.get("version"), VERSION)]
    try:
        if s["unmeasured"]:
            return "unmeasured", []
        rows = s["decisions"]["rows"]
        counted = [r for r in rows if r["status"] in ("met", "unmet", "unchecked")]
        met = sum(1 for r in counted if r["status"] == "met")
        if met != s["decisions"]["met"] or len(counted) != s["decisions"]["of"]:
            problems.append("its decision counts (%s of %s) contradict its rows (%d of %d)"
                            % (s["decisions"]["met"], s["decisions"]["of"], met, len(counted)))
        frames = s["pictures"]["frames"]
        measured = [f for f in frames if f["status"] == "measured"]
        if any(f["status"] not in ("measured", "excepted") for f in frames):
            problems.append("it holds a frame that was neither measured nor excepted, yet lists nothing unmeasured")
        whole = bool(measured) and all(f["matched"] == f["compared"] and f["compared"] > 0 for f in measured)
        verdict = "matched" if (counted and met == len(counted) and whole) else "not-matched"
    except (KeyError, TypeError) as err:
        return None, ["it is missing %s" % err]
    if verdict != s.get("verdict"):
        problems.append("its rows give %s, which contradict its stored verdict %s" % (verdict, s.get("verdict")))
    return verdict, problems


def render(s):
    lines = []
    commit = s.get("commit")
    at = (" at %s" % commit[:7]) if isinstance(commit, str) and commit else " (no commit recorded)"
    lines.append("design-score: %s, %s, against %s%s" % (s.get("design") or s.get("designFile") or "(no design read)",
                                                          s.get("platform") or "unknown platform",
                                                          s.get("build") or "(no build named)", at))
    if s.get("dirty"):
        lines.append("  drawn from a checkout with uncommitted changes, so this score belongs to no commit")
    dec = s["decisions"]
    rows = dec["rows"]
    if rows:
        lines.append("  decisions  %d of %d met (%s)" % (dec["met"], dec["of"],
                                                      pct(dec["met"] / dec["of"] if dec["of"] else 0,
                                                          dec["of"] > 0 and dec["met"] == dec["of"])))
        for r in rows:
            if r["status"] == "unmet":
                lines.append("    UNMET %s %s: %s" % (r["id"], r["decision"], r.get("detail", "")))
            elif r["status"] == "unchecked":
                lines.append("    UNCHECKED %s %s: %s" % (r["id"], r["decision"], r.get("detail", "")))
            elif r["status"] == "picture":
                lines.append("    %s rests on the picture half: %s" % (r["id"], r["decision"]))
            elif r["status"] == "elsewhere":
                lines.append("    %s is proven elsewhere: %s" % (r["id"], r.get("detail", "")))
            elif r["status"] == "excepted":
                lines.append("    %s is skipped by %s" % (r["id"], r.get("detail", "")))
    frames = s["pictures"]["frames"]
    measured = [f for f in frames if f["status"] == "measured"]
    if measured:
        whole = all(f["matched"] == f["compared"] for f in measured)
        lines.append("  pictures   %s of pixels match over %d frame%s" % (
            pct(s["pictures"]["score"], whole), len(measured), "" if len(measured) == 1 else "s"))
    for f in frames:
        if f["status"] == "measured":
            lines.append("    %-4s %5d wide  picture %6s  (%d of %d pixels)%s" % (
                f["id"], f["width"], pct(f["score"], f["matched"] == f["compared"]), f["matched"], f["compared"],
                "  see %s" % f["diff"] if f.get("diff") and f["matched"] != f["compared"] else ""))
        elif f["status"] == "excepted":
            lines.append("    %-4s skipped by %s" % (f["id"], f.get("detail", "")))
    exc = s.get("exceptions") or []
    if exc:
        lines.append("  exceptions %d approved by Dan, skipped by this score:" % len(exc))
        for x in exc:
            target = ("decision %s" % x["decision"]) if "decision" in x else (
                "frame %s%s" % (x["frame"], (" region %s" % x["region"]) if "region" in x else ""))
            lines.append("    %s, %s, %s: \"%s\" (%s)" % (x.get("id"), target, x.get("date"), x.get("words"),
                                                        x.get("source")))
    elif not s["unmeasured"]:
        lines.append("  exceptions none recorded in the design")
    for note in s.get("notes") or []:
        lines.append("  note: %s" % note)
    for reason in s["unmeasured"]:
        lines.append("  NO SCORE: %s" % reason)
    verdict = s["verdict"]
    lines.append("  MATCHED: both halves are 100%" if verdict == "matched"
                 else "  not matched yet" if verdict == "not-matched" else "  could not score")
    return lines


EXIT = {"matched": 0, "not-matched": 1, "unmeasured": 2}


def main(argv):
    # A fault in the score itself is no score, exit 2: left to python it exits 1, which is the code
    # for "not matched yet" and would read as a measurement (lessons review of stage 1, L11).
    try:
        return _main(argv)
    except Exception as err:  # noqa: BLE001
        print("design-score: could not score: the score itself failed (%s: %s)" % (type(err).__name__, err))
        return 2


USAGE = ("usage: design_score.py score <capture folder> | show <score.json> | "
         "post <score.json> --repo <owner/name> --pr <number> | frames <settled design>")


def post(score_path, repo, pr):
    """Posts a score on pull request `pr` and on its milestone's "Match the settled design" issue,
    where the close gate reads it. Exit 0 posted on both, 1 posted on the pull request only (it is
    in no milestone, or the milestone holds no Match issue for this design), 2 nothing posted, or a
    comment GitHub refused."""
    import tempfile
    import score_github as sg
    try:
        s = _load_json(score_path, "the score file")
    except Unreadable as err:
        print("design-score post: nothing posted: %s" % err)
        return 2
    _verdict, problems = verify_score(s)
    if problems:
        print("design-score post: nothing posted: %s %s" % (score_path, "; ".join(problems)))
        return 2
    gh = sg.GitHub()
    try:
        view = json.loads(gh.call(["pr", "view", str(pr), "--repo", repo, "--json",
                                   "number,url,headRefOid,milestone"], repo))
    except (sg.GitHubError, ValueError) as err:
        print("design-score post: nothing posted: pull request %s in %s could not be read (%s)" % (pr, repo, err))
        return 2
    head = view.get("headRefOid") or ""
    note = ""
    if s.get("commit") != head:
        note = ("Measured at `%s`, which is not this pull request's head `%s`, so it does not count for "
                "closing on this head." % ((s.get("commit") or "no commit")[:7], head[:7]))
    fd, body_file = tempfile.mkstemp(suffix=".md")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(sg.score_comment(s, render(s), note))
    try:
        gh.call(["pr", "comment", str(pr), "--repo", repo, "--body-file", body_file], repo)
        print("design-score post: posted on %s" % view.get("url"))
        if note:
            print("design-score post: " + note)
        milestone = view.get("milestone") or {}
        if not milestone.get("number"):
            print("design-score post: NO MATCH ISSUE: pull request %s is in no milestone, so the score is on the "
                  "pull request only, where the close gate does not read it" % pr)
            return 1
        matches = sg.match_issues(gh, repo, milestone["number"], s.get("design"))
        if not matches:
            print("design-score post: NO MATCH ISSUE: milestone %s holds no Match the settled design issue for %s, "
                  "so the score is on the pull request only" % (milestone.get("title"), s.get("design")))
            return 1
        for issue in matches:
            gh.call(["issue", "comment", str(issue["number"]), "--repo", repo, "--body-file", body_file], repo)
            print("design-score post: posted on %s#%d, where the close gate reads it" % (repo, issue["number"]))
        return 0
    except sg.GitHubError as err:
        print("design-score post: posting failed: %s" % err)
        return 2
    finally:
        os.unlink(body_file)


def _main(argv):
    if len(argv) == 7 and argv[1] == "post" and argv[3] == "--repo" and argv[5] == "--pr":
        return post(argv[2], argv[4], argv[6])
    if len(argv) == 3 and argv[1] == "frames":
        # The frames a platform adapter draws, read by this one reader so the adapters and the score
        # never disagree about which frames a design has or how wide each is (claude-config#1364).
        try:
            _raw, _decisions, frames, _exceptions = read_design(argv[2], frames_only=True)
        except Unreadable as err:
            print("design-score: could not read the frames: %s" % err)
            return 2
        print(json.dumps({"frames": frames}))
        return 0
    if len(argv) != 3 or argv[1] not in ("score", "show"):
        print(__doc__.strip().split("\n\n")[0])
        print(USAGE)
        return 2
    if argv[1] == "score":
        folder = argv[2]
        s = score_capture(folder)
        if os.path.isdir(folder):
            with open(os.path.join(folder, "score.json"), "w", encoding="utf-8") as fh:
                json.dump(s, fh, indent=1)
        else:
            s["unmeasured"].append("the capture folder %s is not there" % folder)
            s["verdict"] = "unmeasured"
        print("\n".join(render(s)))
        return EXIT[s["verdict"]]
    try:
        s = _load_json(argv[2], "the score file")
    except Unreadable as err:
        print("design-score: could not score: %s" % err)
        return 2
    verdict, problems = verify_score(s)
    if problems:
        print("design-score: could not score: %s %s" % (argv[2], "; ".join(problems)))
        return 2
    print("\n".join(render(s)))
    return EXIT[verdict]


if __name__ == "__main__":
    sys.exit(main(sys.argv))
