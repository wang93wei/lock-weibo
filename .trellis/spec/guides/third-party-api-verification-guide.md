# Third-Party API Verification Thinking Guide

> **Purpose**: Prevent bugs caused by trusting remembered or second-hand API contracts. Always verify a third-party (internal/undocumented) API against a live source before coding against it.

---

## When to Use

- [ ] You are about to call an API that has **no official public documentation** (reverse-engineered, internal AJAX, private endpoints).
- [ ] You "remember" the endpoint name / parameters / field types from a past project.
- [ ] You found a third-party repo/blog describing the API.
- [ ] The target platform is one that changes its private APIs without notice (social platforms, e-commerce, etc.).

→ **Stop and verify first-hand before writing the call.**

---

## Why This Matters

Private/undocumented APIs drift. The single most expensive class of bug here is **confidently wrong memory**:

- **Endpoint name drift**: `setVisibleCustom` (old name, from memory) vs `modifyVisible` (actual current name). Code looks plausible, ships, and silently 404s.
- **Field shape drift**: `visible` was a number in an old client, now an **object** `{type, list_id}`. A filter like `blog.visible === 1` matches nothing; `blog.visible.type === 1` is correct.
- **Value-type drift**: `visible=1` (number) vs `visible="1"` (string). Sometimes both work, sometimes only one does.
- **Enum drift**: enum values get renumbered; a hardcoded `2` that meant "friends circle" now means something else.

Every one of these was a **real** finding during the weibo batch-locker task (2026-07-27), caught only because the contract was verified against the platform's own frontend bundle, not memory.

---

## Verification Tiers (cheapest first)

1. **Official docs** — if they exist and are current, use them. Note the version/date.
2. **The platform's own client code** — the most authoritative source for *current* behavior.
   - Web: find the main JS bundle (DevTools → Sources/Network), search it for the endpoint string and read the actual call site. The call site shows real param names, types, and response handling.
   - Mobile: harder; skip unless necessary.
3. **Live request capture** — DevTools → Network, perform the action manually once, read the real request (URL, method, headers, body) and response. This is the ground truth for auth headers and exact field shapes.
4. **Third-party repos/blogs** — **lowest trust**. Useful as a *hint* for where to look, but never as the contract itself. Always cross-check against tier 2 or 3. Note where they disagree with reality.

---

## Checklist Before Writing the Call

- [ ] Endpoint URL verified against a live source (not memory).
- [ ] HTTP method verified.
- [ ] Every request parameter name **and type** verified (string vs number matters).
- [ ] Response success/failure shape verified (`ok` field? status code? nested object?).
- [ ] Auth mechanism verified (cookie name, header name like `x-xsrf-token`, whether the cookie is HttpOnly).
- [ ] Enum values verified against the platform's own code where possible.
- [ ] **Ownership/capability verified per item shape** — appearing in a user's feed/profile does not prove the returned top-level entity is owned or mutable by that user. Compare owner IDs and inspect the official action menu for derived entries such as quick reposts.
- [ ] **Non-2xx response bodies captured and retryability classified** — parse `message` / `msg` / `error` before deciding to retry. Deterministic business refusals (ownership, validation, unsupported action) must not use transient-error backoff.
- [ ] Record findings to a `research/<topic>.md` file with the verification date and source URL, so the next session doesn't re-derive (or mis-remember) it.

---

## Record the Contract

Conversations get compacted; files don't. Write the verified contract to a research file even if you're "sure" you'll remember it:

```markdown
# <API> — first-hand verification (YYYY-MM-DD)

Source: <bundle URL / DevTools capture / docs URL>

## Endpoint
POST /ajax/statuses/modifyVisible

## Request
Body (form): ids=<mid>&visible="1"   ← note string type
Headers: x-xsrf-token (from document.cookie XSRF-TOKEN)

## Response
{ ok: >0, statuses: [...] }

## Enum
1 = 仅自己可见   ← verified from bundle menu builder + posting selector
```

This is exactly what `.trellis/tasks/archive/2026-07/07-27-weibo-batch-locker/research/weibo-api-notes.md` is.

---

## Anti-Patterns

- ❌ "I've used this API before, the param is `visible: 1`" → verify the *current* shape.
- ❌ Copy-pasting a call from a 3-year-old Stack Overflow answer.
- ❌ Trusting a third-party scraper repo's parameter names without reading the platform's own code.
- ❌ Writing the whole feature, then discovering at integration time that the endpoint 404s.
- ❌ Treating every item returned by “my profile/feed” as an owned, mutable entity without checking its owner and available official actions.
- ❌ Throwing on `!response.ok` before reading the response body, then blindly retrying every 4xx as though it were transient.

---

**Core Principle**: One minute reading the platform's own bundle saves one hour of "why does this return ok:0?" debugging.
