# theneverless.com domain cutover — runbook

**Date:** 2026-07-14
**Goal:** Move the blog's primary domain from `anping.us` to `theneverless.com` (bought at GoDaddy 2026-07-14). `anping.us` becomes a permanent 301 redirect. `cdn.anping.us` (R2 images) is untouched.

**End state**

- Canonical: `https://theneverless.com` (apex). `www.theneverless.com` 301s to apex (GitHub handles it).
- `anping.us/*` and `www.anping.us/*` → 301 → `https://theneverless.com/*` (path + query preserved, Cloudflare redirect rule).
- `emrickk.github.io` → 301 to the new domain (GitHub automatic).
- `cdn.anping.us` unchanged — image CDN is independent of the site domain.

**Accounts involved:** Cloudflare (already hosts anping.us zone), GoDaddy (registrar for both domains), GitHub (emrickk).

---

## Phase 1 — Add theneverless.com to Cloudflare  [Anping]

1. Log in at dash.cloudflare.com (the account that has anping.us).
2. Account Home → **Add a domain** → enter `theneverless.com` → keep "Quick scan for DNS records" → Continue.
3. Pick the **Free** plan → Continue.
4. On the DNS review screen, delete any imported GoDaddy parking records (usually an A `@` "Parked" and a `www` CNAME), then add — all **DNS only (grey cloud)**:

   | Type  | Name | Value                | Proxy    |
   |-------|------|----------------------|----------|
   | A     | `@`  | `185.199.108.153`    | DNS only |
   | A     | `@`  | `185.199.109.153`    | DNS only |
   | A     | `@`  | `185.199.110.153`    | DNS only |
   | A     | `@`  | `185.199.111.153`    | DNS only |
   | CNAME | `www`| `emrickk.github.io`  | DNS only |

   Grey cloud is REQUIRED: GitHub must see its own IPs at the apex to issue the Let's Encrypt cert. Proxying breaks cert issuance.
5. Continue → Cloudflare shows the zone's two nameservers. Copy them (same account, so likely `diana.ns.cloudflare.com` / `jacob.ns.cloudflare.com`, but use whatever it shows).

## Phase 2 — Switch nameservers at GoDaddy  [Anping]

1. godaddy.com → sign in → My Products → **Domains** → `theneverless.com` → **Manage DNS** (or Domain Settings → Nameservers).
2. Nameservers → **Change Nameservers** → "I'll use my own nameservers" → enter the two Cloudflare nameservers → Save → confirm the warning.
3. Wait for Cloudflare's "theneverless.com is now active" email / the zone showing **Active** (minutes to a couple of hours).
4. Verify from a terminal:
   ```sh
   dig +short NS theneverless.com        # → the two Cloudflare NS
   dig +short theneverless.com           # → the four 185.199.x.153 IPs
   dig +short www.theneverless.com CNAME # → emrickk.github.io
   ```

Nothing user-visible changes in Phases 1–2. Safe to stop at any point.

## Phase 3 — Repo changes  [Claude]

1. `astro-theme-config.ts` line 16: `url: 'https://anping.us'` → `'https://theneverless.com'` (drives canonical links, sitemap, RSS, Open Graph).
2. `public/CNAME`: `anping.us` → `theneverless.com` (inert with Actions-based Pages, kept in sync as documentation).
3. `CLAUDE.md` line 7: update "served at https://anping.us" wording.
4. `.github/workflows/deploy.yml` line 29: update the comment mentioning anping.us.
5. `npm run build` + `npm run release-check` → GO.
6. Commit on `main` with explicit paths (concurrent-session rule). Push only per [[blog-push-protocol]] (double confirmation containing "push"). Deploy runs on push; site is still served at anping.us until Phase 5 (the Settings → Pages domain governs, not the CNAME file). New sitemap/canonicals pointing at theneverless.com a few minutes early is harmless.

## Phase 4 — Pre-stage the anping.us redirect  [Anping, guided]

In the **anping.us** zone on Cloudflare:

1. **Rules** → Create rule → **Redirect Rule**:
   - Name: `anping.us → theneverless.com`
   - If, custom filter expression:
     ```
     (http.host eq "anping.us") or (http.host eq "www.anping.us")
     ```
     (must NOT match `cdn.anping.us`)
   - Then: **Dynamic** redirect, expression:
     ```
     concat("https://theneverless.com", http.request.uri.path)
     ```
     Status **301**, check **Preserve query string**.
   - Save & enable.
2. This rule is dormant for now: redirect rules only fire on **proxied** traffic, and the anping.us records are currently DNS-only. It activates the moment records go orange in Phase 5. Do not touch DNS records yet.

## Phase 5 — The flip  [Anping, ~2 minutes]

Do these back-to-back; anping.us 404s in the gap between step 1 and 2.

1. GitHub: `github.com/emrickk/emrickk.github.io` → **Settings → Pages** → Custom domain: replace `anping.us` with `theneverless.com` → **Save**. DNS check should pass (Phase 2 done).
2. Cloudflare, anping.us zone → **DNS**: edit the four apex `A` records and the `www` record → toggle Proxy status to **Proxied (orange)**. The Phase-4 rule now serves the 301s. Leave `cdn` alone.
3. Back on GitHub Pages settings: wait for "DNS check successful" + TLS certificate (minutes up to ~1 hour), then tick **Enforce HTTPS**. Until the cert issues, `https://theneverless.com` shows a cert warning — normal, temporary.
4. Optional hardening (recommended): github.com → Settings (account) → Pages → **Add a verified domain** → `theneverless.com` → add the shown TXT record (`_github-pages-challenge-emrickk`) in the theneverless.com Cloudflare zone. Repeat for `anping.us` if never done.

## Phase 6 — Verification  [Claude]

```sh
curl -sI https://theneverless.com/                      # 200
curl -sI https://www.theneverless.com/                  # 301 → https://theneverless.com/
curl -sI "https://anping.us/posts/bmw-330i/?q=1"        # 301 → same path+query on theneverless.com
curl -sI http://anping.us/                              # 301 chain to https://theneverless.com/
curl -sI https://emrickk.github.io/                     # 301 → theneverless.com
curl -s  https://theneverless.com/sitemap-index.xml | head -3   # URLs on new domain
curl -sI https://cdn.anping.us/<any-known-image>.webp   # still 200
```

Plus a browser pass: homepage, one bilingual post (toggle works), og:url in page source, RSS feed URL.

## Rollback

Reverse Phase 5: set Pages custom domain back to `anping.us`, flip the anping.us records back to DNS-only (grey), revert the Phase 3 commit, push. Restores the old state in minutes. theneverless.com's Cloudflare zone can stay — it just goes back to being unused.

## Notes

- SEO churn is negligible — the site has been live only since 2026-07-12.
- giscus is not enabled yet, so no comment-system domain config to update. When enabling it later, register the new domain.
- Historical docs/specs mentioning anping.us are left as-is (historical record).
