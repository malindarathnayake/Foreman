"""Experiment 3 — chatbot thin-slice harness.
Architecture under test: MODEL routes (NL -> endpoint call) ; API injects identity + scope ;
ENDPOINTS retrieve+compute (deterministic) ; JINJA renders (deterministic). Model never
sees company_id, never writes SQL, never computes a value, never writes the prose.

Usage:
  python harness.py prompt                 # print system prompt + per-query user messages (for agent arms)
  python harness.py local                  # run reasoner-large as the router (HTTP), score
  python harness.py replay <model> <file>  # score pre-collected router outputs {qid: {"calls":[...]}}
"""
import sqlite3, os, json, re, sys, statistics
from jinja2 import Template
sys.path.insert(0, os.path.dirname(__file__))
from queries import QUERIES

DB = os.path.join(os.path.dirname(__file__), "fleet.db")
LOCAL_URL = "http://192.168.162.105:31081/v1/chat/completions"
LOCAL_MODEL = "reasoner-large"

# ---------------------------------------------------------------- endpoint catalog (= model tools)
ENDPOINTS = {
    "get_current_status":     {"params": {"truck_id": "string"}, "required": ["truck_id"], "target": "truck",
                               "desc": "Current location, status and dwell time for ONE truck."},
    "get_trucks_at_location": {"params": {"location": "string"}, "required": ["location"], "target": "location",
                               "desc": "List trucks currently AT a named location/warehouse."},
    "get_avg_dwell":          {"params": {"location": "string", "since": "string?"}, "required": ["location"], "target": "location",
                               "desc": "AVERAGE dwell/loading time in minutes at a location over recent history."},
    "get_route_history":      {"params": {"truck_id": "string", "day": "string?"}, "required": ["truck_id"], "target": "truck",
                               "desc": "Ordered stops of a truck's route for a day (defaults to latest)."},
    "get_assets":             {"params": {"group": "string?"}, "required": [], "target": "list",
                               "desc": "List the company's trucks, optionally filtered by fleet group."},
}

SYSTEM_PROMPT = (
    "You are the ROUTER for a fleet chatbot. Your ONLY job: read the user's question and choose which "
    "API endpoint(s) to call and with what typed parameters. You do NOT write SQL, do NOT compute values, "
    "do NOT write the answer. You never handle company_id or user identity (the server injects that).\n\n"
    "Available endpoints:\n" +
    "\n".join(f"- {n}({', '.join(m['params'])}) : {m['desc']}" for n, m in ENDPOINTS.items()) +
    "\n\nRules:\n"
    "- Output ONLY a JSON object: {\"calls\": [ {\"endpoint\": \"<name>\", \"params\": { ... }} ]}\n"
    "- Use ONLY endpoints from the list. Put ONLY the listed params. Do not invent params or company_id.\n"
    "- A compound question may need more than one call (e.g. list assets AND average dwell).\n"
    "- If NO endpoint can answer the question, return {\"calls\": []}.\n"
    "- No prose, no markdown, no SQL — JSON only."
)

# ---------------------------------------------------------------- Jinja templates (deterministic voice)
def _dur(m):
    h, mm = divmod(int(m), 60)
    if h and mm: return f"{h}h {mm}m"
    if h: return f"{h} hour{'s' if h != 1 else ''}"
    return f"{mm} minutes"

TEMPLATES = {
    "get_current_status": Template("{{d.truck_id}} is currently {{d.status}} at {{d.location}} (for {{ dur(d.duration_min) }})."),
    "get_trucks_at_location": Template("{{ d.trucks|length }} truck(s) at {{d.location}}: {{ d.trucks|map(attribute='truck_id')|join(', ') }}."),
    "get_avg_dwell": Template("Average dwell time at {{d.location}} is {{d.avg_dwell_minutes}} minutes over {{d.visit_count}} visits."),
    "get_route_history": Template("{{d.truck_id}} route on {{d.day}}: {{ d.stops|map(attribute='location')|join(' -> ') }}."),
    "get_assets": Template("{{ d.trucks|length }} trucks{% if d.group %} in group {{d.group}}{% endif %}: {{ d.trucks|map(attribute='truck_id')|join(', ') }}."),
    "_denied": Template("You don't have access to {{ resource }}."),
    "_oos": Template("That's outside what I can answer right now (no supported data endpoint for this request)."),
}

# ---------------------------------------------------------------- API: identity + scope + execute
def resolve_user(conn, user_id):
    r = conn.execute("SELECT company_id, access_type FROM app_user WHERE user_id=?", (user_id,)).fetchone()
    company_id, access = r
    grants = None
    if access == "SCOPED":
        grants = {x[0] for x in conn.execute("SELECT truck_id FROM user_grant WHERE user_id=?", (user_id,))}
    return company_id, access, grants

def _truck_visible(conn, company_id, grants, truck_id):
    row = conn.execute("SELECT company_id FROM truck WHERE truck_id=?", (truck_id,)).fetchone()
    if not row or row[0] != company_id:      # tenant isolation
        return False
    if grants is not None and truck_id not in grants:   # resource scope
        return False
    return True

def execute_call(conn, company_id, grants, endpoint, params):
    """Returns (outcome, data). outcome: OK | ACCESS_DENIED."""
    p = {k: v for k, v in (params or {}).items()}
    if endpoint == "get_current_status":
        tid = str(p.get("truck_id", ""))
        if not _truck_visible(conn, company_id, grants, tid):
            return "ACCESS_DENIED", {"resource": tid}
        r = conn.execute("SELECT truck_id, location, status, duration_min FROM current_status WHERE truck_id=?", (tid,)).fetchone()
        if not r: return "ACCESS_DENIED", {"resource": tid}
        return "OK", dict(truck_id=r[0], location=r[1], status=r[2], duration_min=r[3])
    if endpoint == "get_route_history":
        tid = str(p.get("truck_id", ""))
        if not _truck_visible(conn, company_id, grants, tid):
            return "ACCESS_DENIED", {"resource": tid}
        day = p.get("day") or conn.execute("SELECT MAX(day) FROM route_stop WHERE truck_id=?", (tid,)).fetchone()[0]
        stops = [dict(seq=s[0], location=s[1], kind=s[2], status=s[3])
                 for s in conn.execute("SELECT seq, location, kind, status FROM route_stop WHERE truck_id=? AND day=? ORDER BY seq", (tid, day))]
        return "OK", dict(truck_id=tid, day=day, stops=stops)
    if endpoint == "get_trucks_at_location":
        loc = str(p.get("location", ""))
        rows = conn.execute(
            "SELECT cs.truck_id, cs.status, cs.duration_min FROM current_status cs JOIN truck t ON t.truck_id=cs.truck_id "
            "WHERE t.company_id=? AND lower(cs.location)=lower(?)", (company_id, loc)).fetchall()
        trucks = [dict(truck_id=r[0], status=r[1], duration_min=r[2]) for r in rows
                  if grants is None or r[0] in grants]
        return "OK", dict(location=loc, trucks=trucks)
    if endpoint == "get_avg_dwell":
        loc = str(p.get("location", ""))
        rows = conn.execute(
            "SELECT se.duration_min, se.truck_id FROM stop_event se JOIN truck t ON t.truck_id=se.truck_id "
            "WHERE t.company_id=? AND lower(se.location)=lower(?)", (company_id, loc)).fetchall()
        vals = [r[0] for r in rows if grants is None or r[1] in grants]
        avg = round(statistics.mean(vals), 1) if vals else 0
        return "OK", dict(location=loc, avg_dwell_minutes=avg, visit_count=len(vals))
    if endpoint == "get_assets":
        grp = p.get("group")
        sql = "SELECT truck_id, fleet_group, name FROM truck WHERE company_id=? AND active=1"
        args = [company_id]
        if grp:
            sql += " AND lower(fleet_group)=lower(?)"; args.append(grp)
        rows = conn.execute(sql, args).fetchall()
        trucks = [dict(truck_id=r[0], fleet_group=r[1], name=r[2]) for r in rows if grants is None or r[0] in grants]
        return "OK", dict(group=grp, trucks=trucks)
    return "ACCESS_DENIED", {"resource": endpoint}

def render(endpoint, outcome, data):
    if outcome == "ACCESS_DENIED":
        return TEMPLATES["_denied"].render(resource=data.get("resource", "that resource"))
    return TEMPLATES[endpoint].render(d=data, dur=_dur)

# ---------------------------------------------------------------- router output parsing / validation
def parse_calls(raw):
    if raw is None: return None
    if isinstance(raw, dict): obj = raw
    else:
        s = raw.strip()
        s = re.sub(r"^```[a-zA-Z]*", "", s).strip().rstrip("`").strip()
        try:
            obj = json.loads(s)
        except Exception:
            m = re.search(r"\{.*\}", s, re.DOTALL)
            if not m: return None
            try: obj = json.loads(m.group(0))
            except Exception: return None
    if "calls" not in obj and "endpoint" in obj:
        obj = {"calls": [obj]}
    calls = obj.get("calls", [])
    return calls if isinstance(calls, list) else None

def validate(calls):
    """Return (valid_calls, error|None). Empty list is valid (out-of-scope)."""
    if calls == []: return [], None
    out = []
    for c in calls:
        ep = c.get("endpoint")
        if ep not in ENDPOINTS:
            return None, f"unknown endpoint '{ep}'"
        params = c.get("params", {}) or {}
        for req in ENDPOINTS[ep]["required"]:
            if req not in params:
                return None, f"{ep} missing required param '{req}'"
        out.append({"endpoint": ep, "params": params})
    return out, None

# ---------------------------------------------------------------- local model seat (HTTP)
def route_local(user_msg, retry_hint=None):
    import requests
    msgs = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user_msg}]
    if retry_hint:
        msgs.append({"role": "user", "content": retry_hint})
    r = requests.post(LOCAL_URL, json={"model": LOCAL_MODEL, "messages": msgs,
                                       "max_tokens": 1200, "temperature": 0.2, "top_p": 0.9}, timeout=180)
    return r.json()["choices"][0]["message"].get("content") or ""

# ------------------------------------------------ entity + date resolution (the deterministic layer v3 adds)
RELATIVE_DAYS = {"today", "yesterday", "now", "latest", "current", "this week", "last week", "past week", "recent"}
LOC_ALIASES = {"wh-a": "warehouse a", "wh a": "warehouse a", "wha": "warehouse a", "wh-b": "warehouse b"}

def _company_values(conn, company_id, col, table):
    return [r[0] for r in conn.execute(f"SELECT DISTINCT {col} FROM {table} WHERE company_id=?", (company_id,))]

def resolve_params(conn, company_id, endpoint, params):
    """Deterministic, access-scoped alias/date resolution. Maps 'Fleet Alpha'->'Alpha', 'WH-A'->'Warehouse A',
    strips relative dates so the endpoint resolves them server-side."""
    p = dict(params or {})
    if isinstance(p.get("truck_id"), str):
        p["truck_id"] = p["truck_id"].strip().upper().replace("TRUCK ", "").strip()
    if isinstance(p.get("group"), str):
        groups = _company_values(conn, company_id, "fleet_group", "truck")
        val = p["group"].strip().lower()
        match = (next((g for g in groups if g.lower() == val), None)
                 or next((g for g in groups if g.lower() in val.split()), None)
                 or next((g for g in groups if g.lower() in val), None))
        if match: p["group"] = match
    if isinstance(p.get("location"), str):
        val = LOC_ALIASES.get(p["location"].strip().lower(), p["location"].strip().lower())
        locs = _company_values(conn, company_id, "name", "location")
        match = (next((l for l in locs if l.lower() == val), None)
                 or next((l for l in locs if val in l.lower() or l.lower() in val), None))
        if match: p["location"] = match
    if isinstance(p.get("day"), str) and p["day"].strip().lower() in RELATIVE_DAYS:
        del p["day"]   # server resolves relative dates; route-history defaults to latest available
    return p

# ---------------------------------------------------------------- run one query end-to-end
def run_query(conn, case, get_route, improved=False):
    """get_route(user_msg, retry_hint) -> raw router text (or a preparsed dict for replay).
    improved=True adds the v3 system layers: entity/date resolution + strict handling (unknown endpoint ->
    out-of-scope instead of a hard schema fail)."""
    raw = get_route(case["nl"], None)
    calls = parse_calls(raw)
    valid, err = (None, "unparseable") if calls is None else validate(calls)
    if valid is None and getattr(get_route, "__name__", "") == "local_router":
        raw = get_route(case["nl"], f"Your previous output was invalid ({err}). Return ONLY the JSON object.")
        calls = parse_calls(raw)
        valid, err = (None, "unparseable") if calls is None else validate(calls)
    schema_valid = valid is not None

    if improved and valid is None:
        raw_calls = parse_calls(raw) or []
        valid = [c for c in raw_calls if c.get("endpoint") in ENDPOINTS
                 and all(r in (c.get("params") or {}) for r in ENDPOINTS[c["endpoint"]]["required"])]
    valid = valid or []

    company_id, access, grants = resolve_user(conn, case["user"])
    if improved:
        valid = [{"endpoint": c["endpoint"], "params": resolve_params(conn, company_id, c["endpoint"], c.get("params", {}))}
                 for c in valid]

    if not valid:
        outcome, rendered = "OUT_OF_SCOPE", TEMPLATES["_oos"].render()
    else:
        parts, outcome = [], "OK"
        for c in valid:
            oc, data = execute_call(conn, company_id, grants, c["endpoint"], c["params"])
            if oc == "ACCESS_DENIED":
                outcome = "ACCESS_DENIED"
            parts.append(render(c["endpoint"], oc, data))
        rendered = " ".join(parts)

    got_eps = [c["endpoint"] for c in valid]
    exp = case
    routing_ok = set(got_eps) == set(exp["endpoints"])
    params_ok = True
    for ep, want in exp["params"].items():
        call = next((c for c in valid if c["endpoint"] == ep), None)
        if not call:
            params_ok = params_ok and (ep in got_eps)
            continue
        for k, v in want.items():
            if str(call["params"].get(k, "")).strip().lower() != str(v).strip().lower():
                params_ok = False
    outcome_ok = (outcome == exp["outcome"])
    answer_ok = all(s.lower() in rendered.lower() for s in exp["answer_contains"]) if exp["outcome"] == "OK" else True
    gate = [routing_ok, params_ok, outcome_ok, answer_ok] + ([] if improved else [schema_valid])
    overall = all(gate)
    return dict(id=case["id"], nl=case["nl"], got=got_eps, outcome=outcome, rendered=rendered,
                schema_valid=schema_valid, routing_ok=routing_ok, params_ok=params_ok,
                outcome_ok=outcome_ok, answer_ok=answer_ok, overall=bool(overall))

# ---------------------------------------------------------------- runners
def scorecard(model, results):
    n = len(results)
    agg = {k: sum(1 for r in results if r[k]) for k in ["schema_valid", "routing_ok", "params_ok", "outcome_ok", "answer_ok", "overall"]}
    print(f"\n===== {model} =====")
    print(f"  schema_valid {agg['schema_valid']}/{n}  routing {agg['routing_ok']}/{n}  params {agg['params_ok']}/{n}  "
          f"outcome {agg['outcome_ok']}/{n}  answer {agg['answer_ok']}/{n}  ==> OVERALL {agg['overall']}/{n}")
    for r in results:
        flag = "OK " if r["overall"] else "XX "
        print(f"  {flag}{r['id']:4} route={r['got']} outcome={r['outcome']:12} | {r['rendered'][:80]}")
    outdir = os.path.join(os.path.dirname(__file__), "results")
    os.makedirs(outdir, exist_ok=True)
    json.dump({"model": model, "agg": agg, "n": n, "results": results},
              open(os.path.join(outdir, f"{model}.json"), "w"), indent=2)
    return agg

def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "local"
    conn = sqlite3.connect(DB)
    if cmd == "prompt":
        print("=== SYSTEM PROMPT ===\n" + SYSTEM_PROMPT)
        print("\n=== USER MESSAGES ===")
        for q in QUERIES:
            print(f"{q['id']}: {q['nl']}")
        return
    improved = "improved" in sys.argv
    tag = "+improved" if improved else ""
    if cmd == "local":
        def local_router(user_msg, hint): return route_local(user_msg, hint)
        results = [run_query(conn, q, local_router, improved) for q in QUERIES]
        scorecard("local" + tag, results)
        return
    if cmd == "replay":
        model, path = sys.argv[2], sys.argv[3]
        routes = json.load(open(path))
        def replay_router(user_msg, hint):
            # match by the query text
            qid = next(q["id"] for q in QUERIES if q["nl"] == user_msg)
            return routes.get(qid)
        results = [run_query(conn, q, replay_router, improved) for q in QUERIES]
        scorecard(model + tag, results)
        return

if __name__ == "__main__":
    main()
