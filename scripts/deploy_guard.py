#!/usr/bin/env python3
"""Deploy guard for md-trading-dashboard (Netlify_GitHub_Plan_28Oct2026 rule 4).
Compares a candidate deploy (a free deploy preview) with the deploy currently published to production and ABORTS if:
  1. any function live in production is missing from the candidate (the 26 Oct outage),
  2. any scheduled function in production has lost its schedule in the candidate, unless listed in --allow-unschedule,
  3. any Netlify.env.get('NAME') referenced in the candidate's source is not set in the site's environment.
Usage: NETLIFY_AUTH_TOKEN=... deploy_guard.py --site SITE_ID --candidate DEPLOY_ID [--allow-unschedule daily-monitor-v2,sunday-scanner] [--src netlify/functions]
Exit 0 = safe to publish. Exit 2 = abort. Read-only: never deploys or publishes."""
import argparse, json, os, re, sys, urllib.request

API = "https://api.netlify.com/api/v1"
def get(path, tok):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {tok}"})
    with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read())

def functions_of(deploy_id, tok):
    d = get(f"/deploys/{deploy_id}/functions", tok)
    fs = d.get("functions", d) if isinstance(d, dict) else d
    return {f.get("n") or f.get("name"): (f.get("sch") or f.get("schedule")) for f in fs}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--site", required=True); ap.add_argument("--candidate", required=True)
    ap.add_argument("--allow-unschedule", default=""); ap.add_argument("--src", default="netlify/functions")
    a = ap.parse_args(); tok = os.environ.get("NETLIFY_AUTH_TOKEN")
    if not tok: print("NETLIFY_AUTH_TOKEN missing"); sys.exit(2)
    site = get(f"/sites/{a.site}", tok); prod_id = (site.get("published_deploy") or {}).get("id")
    prod, cand = functions_of(prod_id, tok), functions_of(a.candidate, tok)
    allow = {x.strip() for x in a.allow_unschedule.split(",") if x.strip()}
    problems = []
    missing = sorted(set(prod) - set(cand))
    if missing: problems.append(f"functions live in production but missing from candidate: {missing}")
    lost = sorted(n for n, s in prod.items() if s and n in cand and not cand[n] and n not in allow)
    if lost: problems.append(f"scheduled functions that would lose their schedule: {lost}")
    changed = sorted(f"{n}: {prod[n]} -> {cand[n]}" for n in prod if prod[n] and cand.get(n) and prod[n] != cand[n])
    # env var references in candidate source
    refs = set()
    for root, _, files in os.walk(a.src):
        for fn in files:
            if fn.endswith(".mjs") or fn.endswith(".js"):
                refs |= set(re.findall(r"Netlify\.env\.get\(\s*['\"]([A-Z0-9_]+)['\"]", open(os.path.join(root, fn), encoding="utf8", errors="ignore").read()))
    env = get(f"/accounts/{site['account_slug']}/env?site_id={a.site}", tok)
    names = {e["key"] for e in env}
    unset = sorted(r for r in refs if r not in names and r not in ("URL", "DEPLOY_URL", "CONTEXT", "SITE_ID"))
    if unset: problems.append(f"env vars referenced in source but not set on the site: {unset}")
    print(f"production deploy {prod_id} ({len(prod)} functions) vs candidate {a.candidate} ({len(cand)} functions)")
    print("added:", sorted(set(cand) - set(prod)) or "none"); print("removed:", missing or "none")
    print("schedule changes:", changed or "none"); print("unscheduled (allowed):", sorted(n for n in lost_allowed(prod, cand, allow)) or "none")
    print("env refs:", sorted(refs))
    if problems:
        print("\nABORT:"); [print(" -", p) for p in problems]; sys.exit(2)
    print("\nOK: safe to publish (restore the candidate to production; do not run `netlify deploy --prod`).")

def lost_allowed(prod, cand, allow):
    return [n for n, s in prod.items() if s and n in cand and not cand[n] and n in allow]

if __name__ == "__main__": main()
