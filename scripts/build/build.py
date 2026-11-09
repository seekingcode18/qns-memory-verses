# Regenerates index.html from verses.py (KJV/BSB text + session list) and template.html.
# Usage: python3 scripts/build/build.py
import json, re, sys, os
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from verses import KJV, BSB, SESSIONS, FULL_CHAPTER

def num(v): return int(str(v).rstrip('ab'))
def ranges(vs, dash):
    out, i = [], 0
    while i < len(vs):
        j = i
        while j + 1 < len(vs) and num(vs[j+1]) == num(vs[j]) + 1: j += 1
        out.append(str(vs[i]) if i == j else f"{vs[i]}{dash}{vs[j]}")
        i = j + 1
    return out

def curly(t):
    t = t.replace("'", "’")
    res, open_ = [], True
    for ch in t:
        if ch == '"': res.append("“" if open_ else "”"); open_ = not open_
        else: res.append(ch)
    return "".join(res)

def passage(book, ch, vs):
    full = (book, ch) in FULL_CHAPTER
    ref = f"{book} {ch}" if full else f"{book} {ch}:" + ", ".join(ranges(vs, "–"))
    qbook = "psalms" if book == "Psalm" else book.lower()
    q = f"{qbook} {ch}" if full else f"{qbook} {ch}:" + ",".join(ranges([num(v) for v in vs], "-"))
    p = {"ref": ref, "q": q}
    for name, db in (("kjv", KJV), ("bsb", BSB)):
        p[name] = [[num(v), curly(db[(book, ch)][v])] for v in vs]
    return p

data = [{"n": n, "main": passage(*m), "optional": [passage(*o) for o in opts]} for n, m, opts in SESSIONS]

# LSB text (user-supplied, quoted under the LSB permission terms), matched by session and position
LSB = json.load(open(os.path.join(HERE, 'lsb.json')))
for s, l in zip(data, LSB):
    assert s["n"] == l["n"]
    for p, lp in zip([s["main"]] + s["optional"], l["passages"]):
        assert [v for v, _ in p["kjv"]] == [v for v, _ in lp["lsb"]], p["ref"]
        p["lsb"] = lp["lsb"]
html = open(os.path.join(HERE, 'template.html')).read()
html = html.replace("/*__DATA__*/", json.dumps(data, ensure_ascii=False, indent=1))

# This year's meeting dates (optional). Without it, or once it's out of date, the page shows everything as normal.
sched_path = os.path.join(HERE, 'schedule.json')
schedule = json.load(open(sched_path)) if os.path.exists(sched_path) else None
html = html.replace("/*__SCHEDULE__*/null", json.dumps(schedule, ensure_ascii=False))
open(os.path.join(HERE, '..', '..', 'index.html'), 'w').write(html)
for s in data:
    print(s["n"], "|", s["main"]["ref"], "|", " ; ".join(o["ref"] for o in s["optional"]), "|", s["main"]["q"])
