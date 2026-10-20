"""score_github.py: the design match score's side on GitHub (claude-config#1364).

Shared by `design_score.py post`, which puts a score on a pull request and on its milestone's
"Match the settled design" issue, and by hooks/design-score-gate.py, which refuses to close that
issue or its milestone below 100% on both halves. Both read and write the same three marks here, so
the writer and the reader of a score comment cannot drift apart:

  <!-- design-score-issue {"design": "docs/design/x.html"} -->      in the Match issue's body
  <!-- design-score-milestone {"design": "docs/design/x.html"} -->  in the milestone's description
  <!-- design-score v1 -->                                           at the head of a score comment,
                                                                     the score file in a json block

GitHub is read through `gh`, as whichever logged in account can see the repository: the active
one first, then each other, its token scoped to the one call and never switched (Dan runs sessions
under several accounts at once). That walk is lib/merge-target.sh's mt_pr_view, written again here
because this is python; its cases are the same and so are its reasons (claude-config#463, #1173).
"""
import json
import os
import re
import subprocess

ISSUE_MARK = "design-score-issue"
MILESTONE_MARK = "design-score-milestone"
SCORE_MARK = "<!-- design-score v1 -->"
MATCH_TITLE = "Match the settled design"
_MARK = re.compile(r"<!--\s*(design-score-issue|design-score-milestone)\s+(\{.*?\})\s*-->", re.S)
_SCORE_JSON = re.compile(r"<summary>Score file</summary>\s*```json\n(.*?)\n```", re.S)


class GitHubError(Exception):
    """GitHub could not be read or written, or answered with something that could not be used."""


def mark(kind, design):
    return "<!-- %s %s -->" % (kind, json.dumps({"design": design}))


def read_mark(text, kind):
    """The design path a body's mark of `kind` names, None when it has none. A mark that is not
    readable JSON naming a design raises, since a broken mark must never read as no mark."""
    for m in _MARK.finditer(text or ""):
        if m.group(1) != kind:
            continue
        try:
            design = json.loads(m.group(2)).get("design")
        except (ValueError, AttributeError):
            raise GitHubError("its %s mark is not readable JSON: %s" % (kind, m.group(0)[:200]))
        if not isinstance(design, str) or not design.strip():
            raise GitHubError("its %s mark names no design: %s" % (kind, m.group(0)[:200]))
        return design.strip()
    return None


def is_match_issue(issue):
    """(is it a Match issue, the design its mark names or None). A Match issue is one carrying the
    issue mark, or one titled as one: a hand filed "Match the settled design ..." with no mark is
    still one, and its score cannot be found, which the gate says rather than letting it close."""
    design = read_mark(issue.get("body") or "", ISSUE_MARK)
    titled = (issue.get("title") or "").strip().lower().startswith(MATCH_TITLE.lower())
    return (design is not None or titled), design


def milestone_issues(gh, repo, number):
    """Every issue in milestone `number` of `repo`, open or closed, never a pull request (GitHub lists
    both from this endpoint). Read through `gh` (a GitHub below), every page of it."""
    issues = gh.api("repos/%s/issues?milestone=%d&state=all&per_page=100" % (repo, number), repo, paginate=True)
    return [i for i in issues if not i.get("pull_request")]


def match_issues(gh, repo, number, design):
    """The Match the settled design issues in milestone `number` whose mark names `design`. The one
    reading of a milestone's Match issues the post, the close gate and an app's CI share, so they
    cannot disagree about which issue a score belongs on."""
    return [i for i in milestone_issues(gh, repo, number) if is_match_issue(i)[1] == design]


def score_comment(score, lines, note=""):
    """The body of a score comment: the score as printed, then the score file itself."""
    verdict = {"matched": "matched, both halves 100%", "not-matched": "not matched yet",
               "unmeasured": "could not score"}.get(score.get("verdict"), "could not score")
    commit = score.get("commit") or "no commit"
    out = [SCORE_MARK,
           "**Design match score** for `%s` at `%s` (%s): **%s**" % (score.get("design"), commit[:7],
                                                                   score.get("platform"), verdict)]
    if note:
        out += ["", note]
    out += ["", "```text"] + lines + ["```", "", "<details><summary>Score file</summary>", "",
                                       "```json", json.dumps(score, separators=(",", ":")), "```", "", "</details>"]
    return "\n".join(out)


def read_score_comment(body):
    """The score file a comment carries, None for a comment that is not a score. A comment carrying
    the mark whose score cannot be read raises, so it is reported rather than skipped."""
    if SCORE_MARK not in (body or ""):
        return None
    m = _SCORE_JSON.search(body)
    if not m:
        raise GitHubError("a score comment holds no score file block")
    try:
        return json.loads(m.group(1))
    except ValueError as err:
        raise GitHubError("a score comment's score file is not JSON (%s)" % err)


class GitHub:
    """`gh` as whichever logged in account can see each repository."""

    def __init__(self, gh="gh", runner=subprocess.run):
        self.gh = gh
        self.run = runner
        self.accounts = {}   # repo -> the account that could see it ("" for the active one)
        self._others = None

    def _other_accounts(self):
        if self._others is None:
            proc = self.run([self.gh, "auth", "status"], capture_output=True, text=True)
            self._others = sorted(set(re.findall(r"account ([A-Za-z0-9_.-]+)", proc.stdout + proc.stderr)))
        return self._others

    def call(self, args, repo, cwd=None, binary=False):
        """Runs gh with `args` about `repo`, as the first account that can see it, and gives its output:
        text, or the bytes exactly as gh printed them when `binary`."""
        order = [self.accounts[repo]] if repo in self.accounts else [""]
        tried, last = set(), ""
        i = 0
        while i < len(order):
            account = order[i]
            i += 1
            if account in tried:
                continue
            tried.add(account)
            env = dict(os.environ)
            if account:
                tok = self.run([self.gh, "auth", "token", "-u", account], capture_output=True, text=True)
                if tok.returncode != 0 or not tok.stdout.strip():
                    continue
                env["GH_TOKEN"] = tok.stdout.strip()
            try:
                proc = self.run([self.gh] + args, capture_output=True, env=env, cwd=cwd)
            except OSError as err:
                raise GitHubError("gh could not be run (%s)" % err)
            if proc.returncode == 0:
                self.accounts[repo] = account
                return proc.stdout if binary else proc.stdout.decode("utf-8", errors="replace")
            said = (proc.stderr or proc.stdout or b"").decode("utf-8", errors="replace").strip()
            last = said.splitlines()[0] if said else "gh printed nothing (exit %d)" % proc.returncode
            # Only what a repository another account can see looks like sends the walk on; anything
            # else is GitHub's answer, believed the first time (mt_pr_view, claude-config#1173).
            if "Could not resolve to a Repository" in last or "HTTP 404" in last:
                if account == "" and i >= len(order):
                    order += [a for a in self._other_accounts() if a not in tried]
                continue
            break
        raise GitHubError("gh %s: %s" % (" ".join(args[:3]), last or "no logged in account could see %s" % repo))

    def api(self, endpoint, repo, paginate=False):
        args = ["api", endpoint] + (["--paginate", "--slurp"] if paginate else [])
        out = self.call(args, repo)
        try:
            data = json.loads(out)
        except ValueError as err:
            raise GitHubError("gh api %s answered with something that is not JSON (%s)" % (endpoint, err))
        if paginate:
            return [x for page in data for x in page]
        return data

    def raw(self, path, repo, ref):
        """A file's bytes as GitHub holds it at `ref`."""
        return self.call(["api", "-H", "Accept: application/vnd.github.raw",
                          "repos/%s/contents/%s?ref=%s" % (repo, path, ref)], repo, binary=True)
