# Build CET-4/6 wordlist from ECDICT csv -> data/words.json (minified, embedded into client.js)
import csv, json, re, sys, datetime

SRC = "data/ecdict.csv"
OUT = "data/words.json"
MAX_TRANS = 180

words = []
seen = set()
with open(SRC, "r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    for row in reader:
        tag = (row.get("tag") or "").lower()
        toks = tag.split()
        is4 = "cet4" in toks
        is6 = "cet6" in toks
        if not (is4 or is6):
            continue
        w = (row.get("word") or "").strip()
        if not w or w in seen or " " in w or any(ch.isdigit() for ch in w):
            continue
        seen.add(w)
        ph = (row.get("phonetic") or "").strip().replace("/", "")
        tr = (row.get("translation") or "").strip()
        # translation: senses separated by newlines -> join with "；", collapse spaces
        senses = [re.sub(r"\s+", " ", s).strip() for s in tr.split("\n") if s.strip()]
        tr = "；".join(senses)
        if len(tr) > MAX_TRANS:
            cut = tr[:MAX_TRANS]
            # cut at a sense boundary if possible
            i = cut.rfind("；")
            tr = (cut[:i] if i > 40 else cut) + "…"
        frq = 0
        try:
            frq = int(float(row.get("frq") or 0))
        except ValueError:
            pass
        words.append({
            "w": w,
            "p": ph,
            "t": tr,
            "b": (2 if (is4 and is6) else (1 if is4 else 3)),  # 1=cet4 2=both 3=cet6
            "f": frq,
        })

# order: known-frequency words first (more common first), zero-frq last, then alphabetical
words.sort(key=lambda e: (0 if e["f"] else 1, e["f"], e["w"]))
for i, e in enumerate(words):
    e["i"] = i

n4 = sum(1 for e in words if e["b"] in (1, 2))
n6 = sum(1 for e in words if e["b"] in (2, 3))
data = {"v": 1, "src": "ECDICT (MIT)", "built": datetime.date.today().isoformat(),
        "counts": {"cet4": n4, "cet6": n6, "total": len(words)}, "words": words}
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
print("words:", len(words), "cet4:", n4, "cet6:", n6)
import os
print("bytes:", os.path.getsize(OUT))
