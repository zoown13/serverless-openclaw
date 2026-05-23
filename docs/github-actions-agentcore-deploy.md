# AgentCore GitHub Actions Deployment

This repository deploys the production AgentCore tool runtime through
`.github/workflows/deploy-agentcore.yml`. The production deployment job is
restricted to `refs/heads/main` and the GitHub Actions `production`
environment.

The workflow intentionally uses a separate path from the Fargate image workflow:

- AgentCore images use the default gzip-compatible Docker image format.
- The existing `deploy-image.yml` workflow can remain optimized for Fargate zstd/SOCI.
- The image tag and `AGENTCORE_SESSION_NAMESPACE` are always the same value:
  `agentcore-<short-sha>-gzip`.

## Deployment flow

1. Install dependencies.
2. Run `npm run build`.
3. Run `npm run lint`.
4. Run targeted Gmail/payment runtime regression tests.
5. Build and push an ARM64 container image to ECR.
6. Update the AgentCore Runtime with the new image tag.
7. Deploy `ComputeStack` and `ApiStack` with `DEPLOY_WEB=false`.
8. Run synthetic Telegram smoke when `TELEGRAM_SMOKE_CHAT_ID` is configured.

## Required GitHub secret

| Secret | Purpose |
|---|---|
| `AWS_OIDC_ROLE_ARN` | IAM role assumed by GitHub Actions through OIDC. |

Create or update the AWS role once with:

```powershell
powershell -File .\scripts\setup-github-actions-oidc.ps1
```

Then add the printed `RoleArn` as the GitHub Actions secret
`AWS_OIDC_ROLE_ARN`.

The role trust policy is intentionally narrow. By default it only accepts this
OIDC subject:

```text
repo:zoown13/serverless-openclaw:environment:production
```

Do not add wildcard subjects such as `repo:zoown13/serverless-openclaw:*`
unless you are intentionally opening AWS deployment access to every branch and
environment in the repository.

## Optional GitHub secrets

| Secret | Purpose |
|---|---|
| `TELEGRAM_SMOKE_CHAT_ID` | Telegram chat id used by synthetic smoke. |
| `TELEGRAM_SMOKE_TELEGRAM_ID` | Telegram user id used by synthetic smoke. Defaults to chat id when omitted. |

The Telegram webhook secret is resolved from SSM Parameter Store at runtime, so it
does not need to be copied into GitHub Secrets.

## Rollback

Use `workflow_dispatch` on the same workflow with a previous commit checked out,
or run the local rollback sequence from `docs/agentcore-runtime-operations.md`:

1. Redeploy the previous ECR image tag with `deploy-agentcore-runtime.ps1`.
2. Redeploy Gateway wiring with `deploy-option-b-tool-runtime.ps1`.
3. Set `AGENTCORE_SESSION_NAMESPACE` to the same previous image tag.
