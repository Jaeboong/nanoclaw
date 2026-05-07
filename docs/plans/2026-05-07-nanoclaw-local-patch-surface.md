# NanoClaw Local Patch Surface

## Upstream relation

- `upstream/main` is NanoClaw v2-era and currently far ahead of this v1.2-based checkout.
- Do not merge upstream v2 casually into this working tree.
- Push only to `origin`.

## Local feature layers

| Layer | Commits | Tier | Notes |
|---|---|---|---|
| Discord channel integration | existing history | feature/channel skill | Already carried as local code |
| Observability host | existing history | module + instance templates | Instance values stay ignored |
| DART tooling | existing five commits | module + core env passthrough | API key is instance env |
| Responder routing | new commits | feature/channel module | Shared with OpenClaw responder state |

## Revisit triggers

- If upstream v2 migration is required.
- If Discord channel skill has an upstream branch that supersedes local Discord code.
- If responder routing needs to be shared across multiple channel skills.
- If DART tools should be extracted into a reusable utility skill.
