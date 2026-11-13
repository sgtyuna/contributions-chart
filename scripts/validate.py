"""Quick checks that run on every pull request (no database needed).
The full acceptance checks live in tests/acceptance.mjs and need Docker."""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
web = root / "web"
problems = []

# Starter content: complete, and no kids in it (their names come from the setup screen).
seed = json.loads((web / "seed" / "seed.json").read_text())
if any(p.get("role") == "kid" for p in seed.get("people", [])):
    problems.append("seed.json lists kids; their names belong only in the database")
for key in ["welcome", "pick", "hard_ack", "unfinished_note", "offline_note", "meeting_intro", "nothing_yet"]:
    if not seed.get("texts", {}).get(key, "").strip():
        problems.append(f"seed.json texts.{key} is missing")
for group in ["starter", "ideas"]:
    items = seed.get(group, [])
    if not items:
        problems.append(f"seed.json has no {group}")
    for item in items:
        for field in ["name", "why", "thanks", "icon"]:
            if not str(item.get(field, "")).strip():
                problems.append(f"{group}: '{item.get('name', '?')}' has no {field}")
        if item.get("kind") not in ("daily", "weekly", "once"):
            problems.append(f"{group}: '{item.get('name', '?')}' has kind {item.get('kind')!r}")

# Words the chart never uses.
banned = re.compile(r"\bchores?\b|\bpoints?\b|\bstreaks?\b|\bbadges?\b|good job|great job|well done|\bleaderboard|\bprizes?\b|\bstickers?\b|\brewards?\b", re.I)
for f in [web / "index.html", web / "app.js", web / "seed" / "seed.json", web / "manifest.webmanifest"]:
    for n, line in enumerate(f.read_text().splitlines(), 1):
        if banned.search(line):
            problems.append(f"{f.relative_to(root)}:{n} uses a word the chart avoids: {line.strip()[:80]}")

# Every file the offline copy needs is really there.
sw = (web / "sw.js").read_text()
shell = re.search(r"const SHELL = \[(.*?)\];", sw, re.S).group(1)
for name in re.findall(r"'([^']+)'", shell):
    if name != "./" and not (web / name).exists():
        problems.append(f"sw.js lists {name}, which doesn't exist")

# The app's code parses.
if shutil.which("node"):
    for f in ["app.js", "sw.js", "config.js"]:
        r = subprocess.run(["node", "--check", str(web / f)], capture_output=True, text=True)
        if r.returncode:
            problems.append(f"web/{f} has a syntax error: {r.stderr.strip()[:200]}")
else:
    print("node not found; skipped the syntax check")

if problems:
    print("Problems found:")
    for p in problems:
        print(" -", p)
    sys.exit(1)
print(f"All good: {len(seed['starter'])} starter contributions, {len(seed['ideas'])} ideas, no banned words, offline files present.")
