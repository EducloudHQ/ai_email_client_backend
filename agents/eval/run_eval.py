#!/usr/bin/env python3
import os, sys, json, time, math
from typing import Any, Dict, List, Tuple

# Config
DEFAULT_DATASET = os.environ.get("EVAL_DATASET", "eval/eval_orchestrator.jsonl")
ENDPOINT = os.environ.get("EVAL_ENDPOINT")  # e.g., http://127.0.0.1:8080/invocations
TIMEOUT_S = float(os.environ.get("EVAL_TIMEOUT_S", "60"))

# Import orchestrator module if running local
USE_LOCAL = ENDPOINT is None
if USE_LOCAL:
    # Adjust path to project root
    sys.path.insert(0, os.getcwd())
    from agents import email_agent as orchestrator  # your module

def _http_invoke(payload: Dict[str, Any]) -> Dict[str, Any]:
    import requests
    r = requests.post(ENDPOINT, json=payload, timeout=TIMEOUT_S)
    r.raise_for_status()
    try:
        return r.json()
    except Exception:
        return {"error":"NonJSONResponse","raw": r.text}

def _local_invoke(payload: Dict[str, Any]) -> Dict[str, Any]:
    # Calls your app.entrypoint invoke(payload) which returns dict
    return orchestrator.invoke(payload)

def load_jsonl(path: str) -> List[Dict[str, Any]]:
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line: continue
            rows.append(json.loads(line))
    return rows

def word_count(s: str) -> int:
    return len([w for w in (s or "").split() if w.strip()])

def validate_schema(o: Dict[str, Any]) -> Tuple[bool, List[str]]:
    errors = []
    # Allowed enums
    cat_allowed = {"Work","Personal","Finance","Marketing / Promotions","Social","Spam","Travel","Receipts","Other"}
    sent_allowed = {"Positive","Neutral","Negative","Mixed"}

    # Required keys
    req = ["summary","category","sentiment","is_urgent","key_dates","amounts","action_items","entities","links","attachments"]
    missing = [k for k in req if k not in o]
    if missing:
        errors.append(f"Missing keys: {missing}")

    # Types
    if "summary" in o and not isinstance(o["summary"], str):
        errors.append("summary must be str")
    if "category" in o and not isinstance(o["category"], str):
        errors.append("category must be str")
    if "sentiment" in o and not isinstance(o["sentiment"], str):
        errors.append("sentiment must be str")
    if "is_urgent" in o and not isinstance(o["is_urgent"], bool):
        errors.append("is_urgent must be bool")
    for lk in ["key_dates","amounts","action_items","entities","links","attachments"]:
        if lk in o and not isinstance(o[lk], list):
            errors.append(f"{lk} must be list")

    # Enum checks (only if present)
    if "category" in o and o["category"] not in cat_allowed:
        errors.append(f"category not in allowed set: {o.get('category')}")
    if "sentiment" in o and o["sentiment"] not in sent_allowed:
        errors.append(f"sentiment not in allowed set: {o.get('sentiment')}")

    return (len(errors) == 0, errors)

def judge(case: Dict[str, Any], result: Dict[str, Any]) -> Dict[str, Any]:
    """Return per-case scores and messages."""
    exp = case.get("expect", {})
    out = {"id": case.get("id"), "score": 0.0, "checks": []}

    # If orchestrator returns an error object (allowed)
    if "allow_error_codes" in exp and isinstance(result, dict) and "error" in result:
        allowed = set(exp["allow_error_codes"])
        if result["error"] in allowed:
            out["checks"].append(("allowed_error", True, f"Got error {result['error']}"))
            out["score"] = 1.0
            return out
        else:
            out["checks"].append(("allowed_error", False, f"Unexpected error {result['error']}"))
            return out

    # 1) Schema
    ok, errs = validate_schema(result if isinstance(result, dict) else {})
    out["checks"].append(("schema_valid", ok, "" if ok else "; ".join(errs)))

    # 2) Summary length
    max_words = exp.get("summary_max_words", 60)
    s_ok = False
    if isinstance(result, dict) and "summary" in result and isinstance(result["summary"], str):
        s_ok = word_count(result["summary"]) <= max_words
    out["checks"].append(("summary_len_ok", s_ok, f"<= {max_words} words"))

    # 3) Category in expected set (optional narrow set per case)
    c_ok = True
    if "category_in" in exp:
        c_ok = result.get("category") in set(exp["category_in"])
    out["checks"].append(("category_expected", c_ok, ""))

    # 4) Sentiment in expected set (optional narrow set per case)
    se_ok = True
    if "sentiment_in" in exp:
        se_ok = result.get("sentiment") in set(exp["sentiment_in"])
    out["checks"].append(("sentiment_expected", se_ok, ""))

    # 5) Entities include specific substrings (if requested)
    ent_ok = True
    if "must_have_entities" in exp:
        ents = result.get("entities", [])
        need = set(exp["must_have_entities"])
        ent_ok = all(any(needle in e for e in ents) for needle in need)
    out["checks"].append(("entities_contain_required", ent_ok, ""))

    # 6) Action items contain certain substrings (if requested)
    ai_ok = True
    if "must_have_action_items_substr" in exp:
        aitems = result.get("action_items", [])
        need_sub = exp["must_have_action_items_substr"]
        ai_ok = all(any(sub.lower() in (ai or "").lower() for ai in aitems) for sub in need_sub)
    out["checks"].append(("action_items_expected", ai_ok, ""))

    # 7) smart_reply presence (if required)
    sr_ok = True
    if exp.get("smart_reply_required", False):
        sr_ok = isinstance(result.get("smart_reply",""), str) and len(result.get("smart_reply","")) > 0
    out["checks"].append(("smart_reply_present", sr_ok, ""))

    # Aggregate score (simple fraction of passing checks)
    passed = sum(1 for _, ok, _ in out["checks"] if ok)
    total = len(out["checks"])
    out["score"] = passed / total if total else 0.0
    return out

def main():
    dataset = load_jsonl(DEFAULT_DATASET)
    results = []
    start = time.time()
    for case in dataset:
        mode = case.get("mode", "local")
        payload = case["input"]

        try:
            if mode == "http":
                res = _http_invoke(payload)
            else:
                res = _local_invoke(payload)
        except Exception as e:
            res = {"error":"InvocationFailed","detail": str(e)}

        scored = judge(case, res)
        scored["raw"] = res
        results.append(scored)

    dur = time.time() - start
    # Summary
    avg = sum(r["score"] for r in results) / len(results) if results else 0.0
    print(json.dumps({
        "dataset": DEFAULT_DATASET,
        "endpoint": ENDPOINT or "local invoke()",
        "count": len(results),
        "avg_score": round(avg, 3),
        "duration_s": round(dur, 2),
        "results": results
    }, indent=2))

if __name__ == "__main__":
    main()
