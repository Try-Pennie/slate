#!/usr/bin/env python3
"""post-design-score.py: post a design match score on a pull request in a design milestone (#3954).

    python3 scripts/post-design-score.py <capture folder> --repo <owner/name> --pr <number>

CI's design-score job runs this after the browser leg has drawn the design and the build and scored
them (e2e/tests/60-team-capacity-design.spec.ts writes the capture and its score.json). A pull request
is in a design milestone when its milestone holds a "Match the settled design" issue for the scored
design; there the score is posted, on the pull request and on that issue, by the copied score's own
`post` (scripts/design-score/design_score.py), where the close gate reads it. Anywhere else nothing
is posted and it says so, since a comment on every pull request that touches the app is noise.

Which issue is a Match issue is the copied score's own rule (score_github.is_match_issue), so this
and the close gate cannot disagree about it.

Exit codes: 0 posted, or nothing to post; 2 no score (the capture holds no readable score, or it
says the score could not be measured, since then nothing was measured) or posting failed. A score
reading "not matched yet" is posted and exits 0: that is the expected state while a milestone is
under way, and the browser leg is what fails a design that has stopped matching.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# No __pycache__ inside the copied folder: its check refuses a file that is not part of the copy.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(HERE, "design-score"))
import design_score  # noqa: E402
import score_github as sg  # noqa: E402

USAGE = "usage: post-design-score.py <capture folder> --repo <owner/name> --pr <number>"


def say(msg):
    print("post-design-score: " + msg)


def match_issues(gh, repo, pr, design):
    """The pull request's milestone, and the Match issues in it for `design`."""
    view = json.loads(gh.call(["pr", "view", str(pr), "--repo", repo, "--json", "milestone"], repo))
    milestone = view.get("milestone") or {}
    if not milestone.get("number"):
        return None, []
    issues = gh.api("repos/%s/issues?milestone=%d&state=all&per_page=100" % (repo, milestone["number"]),
                    repo, paginate=True)
    return milestone, [i for i in issues if not i.get("pull_request") and sg.is_match_issue(i)[1] == design]


def main(argv, gh=None, post=design_score.post):
    if len(argv) != 6 or argv[2] != "--repo" or argv[4] != "--pr":
        print(USAGE)
        return 2
    folder, repo, pr = argv[1], argv[3], argv[5]
    score_path = os.path.join(folder, "score.json")
    if not os.path.isfile(score_path):
        say("no score: %s is not there, so the browser leg never reached the design score" % score_path)
        return 2
    try:
        with open(score_path, encoding="utf-8") as fh:
            score = json.load(fh)
    except (OSError, ValueError) as err:
        say("no score: %s could not be read (%s)" % (score_path, err))
        return 2
    verdict, problems = design_score.verify_score(score)
    if problems:
        say("no score: %s %s" % (score_path, "; ".join(problems)))
        return 2
    gh = gh or sg.GitHub()
    try:
        milestone, matches = match_issues(gh, repo, pr, score.get("design"))
    except (sg.GitHubError, ValueError) as err:
        say("nothing posted: the pull request's milestone could not be read (%s)" % err)
        return 2
    if not matches:
        where = ("its milestone %s holds no Match the settled design issue for %s" % (milestone.get("title"), score.get("design"))
                 if milestone else "it is in no milestone")
        say("nothing posted: pull request %s is not in a design milestone (%s); the score reads %s" % (pr, where, verdict))
        return 2 if verdict == "unmeasured" else 0
    rc = post(score_path, repo, pr)
    if rc == 2:
        return 2
    return 2 if verdict == "unmeasured" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
