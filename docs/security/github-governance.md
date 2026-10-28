# GitHub governance: automation develops, the Platform Owner approves

Target:

```
Familista automation → pull request → required CI → the Platform Owner's review → merge → Render
```

The automation account is never treated as the Platform Owner. It cannot
approve its own pull requests. It cannot change the rules that require the
owner's review. It cannot move production by itself.

This file covers four things:
- what was found;
- what the repository now holds;
- the exact configuration the Platform Owner applies;
- how each step is verified.

Nothing in this file creates an account, changes a setting or handles a
credential. Those are the Platform Owner's actions, listed in order in §9.

Status labels used below:
- **Prepared**: written down, not yet applied.
- **Implemented**: in this repository.
- **Configured**: set on GitHub by the owner.
- **Verified**: shown to hold by evidence.
- **Awaiting the owner**.

## 1. What was found (2026-10-28, read-only)

| Fact | Value | How it was read |
|---|---|---|
| Repository | `bibokh/familista-backend`, **public**, owned by a **personal account** (not an organization) | repository API |
| Collaborators | `bibokh` (admin) only | GitHub API, as `bibokh` |
| Identity Claude's GitHub tools act as | **`bibokh`**: the Platform Owner's own account, connected at claude.ai/connect-github | authenticated user; PRs #139–#141 authored and merged as `bibokh` |
| Commits made in Claude sessions | authored `Claude <noreply@anthropic.com>`, pushed with `bibokh`'s connection | git log |
| Ruleset `25019943` "Familista Main Protection" | active on `refs/heads/main` | public rules API |
| Required status checks | the 4 CI jobs, from GitHub Actions (app 15368); `strict: false` | same |
| Pull request rule | required, but approvals **0**, code-owner review **off**, last-push approval **off**, stale dismissal **off** | same |
| Deletion, force push | blocked | same |
| Bypass actors | `[]` as GitHub returns them to an unauthenticated reader (**unverified**: confirm in Settings → Rules) | same |
| Classic branch protection | not readable without admin (403) | branch protection API |
| Workflow tokens | every workflow `contents: read`; no job asks for `write`; no `pull_request_target` | `tests/ci-hardening`, `tests/github-governance` |
| Secrets | `RENDER_DEPLOY_HOOK_URL` (deploy) and `BACKUP_TRIGGER_SECRET` (backup) are **repository** secrets; the restore drill's keys are in the `restore-drill` environment, main only, as its workflow states (**confirm** in Settings → Environments) | workflow files |

**What that means today:**
- **CI is enforced.**
- **Review is not.** Because Claude acts as the owner's account, anything that account can do, Claude can do. Claude can merge, and could approve any pull request not authored by `bibokh`.
- **Write access is production access.** Repository secrets reach any workflow on any branch pushed by anyone with write access.
- **The deploy workflow can be run by hand** by anyone with write access.

## 2. What the repository now holds (implemented)

- **Secrets are scoped to environments only `main` may use.**
  - `deploy.yml` runs its job in the `production` environment; `backup.yml` runs in the `backup` environment.
  - An environment secret is available only to a job that names the environment, and only from a branch the environment allows.
  - A workflow committed on any other branch, by anyone, cannot read them.
  - This takes effect once the owner moves the two secrets into the environments (§5).
- **Only the Platform Owner deploys by hand.**
  - `deploy.yml` runs a manual dispatch only when the account that triggered it, or re-ran it, is `bibokh`.
  - The automatic path is unchanged: CI on a push to main, for the commit still at main's head. The added condition that the CI run was a push closes a theoretical path through a fork branch named `main`.
- **The publication gate requires the full ruleset below.** A weaker ruleset is reported as not enforced, and any real publication is refused. The gate checks:
  - code-owner review;
  - at least one approval;
  - last-push approval;
  - stale dismissal;
  - all four checks from GitHub Actions;
  - up-to-date branches;
  - no force push or deletion;
  - a code owner other than the author.
- **CODEOWNERS** names the Platform Owner, explicitly, for workflows, security controls, publication verification, the evidence approvals, agent governance, deployment and the security documentation. It never names an automation account.
- **`tests/github-governance.unit.test.ts`** pins all of the above. The proposed ruleset (`ruleset-25019943.proposed.json`) must pass the gate's check, and today's must fail it, requirement by requirement.

## 3. The automation identity (prepared; awaiting the owner)

**Recommended name:** `familista-automation`.
- If it is taken, use `familista-automation-bot` or `familista-dev-automation`.
- This session cannot check availability: GitHub's user and search endpoints are outside its repository scope. GitHub reports availability on the sign-up form.

**Terms of Service.** GitHub's Terms of Service allow one free machine account per person, "used exclusively for performing automated tasks", for which the person is responsible. This is that account: it is driven by Claude, never logged into for manual work, and owned by the Platform Owner.

**Create it by hand (the owner, in a browser; never automated):**
1. Sign out of `bibokh`, or use a private window or a separate browser profile.
2. Sign up at github.com with a **separate email address** that you control. A `+automation` alias of your own mailbox works if your provider supports it.
3. Choose the username. Store the password in your password manager only.
4. Verify the email.
5. Enable **two-factor authentication**, an authenticator app or a passkey. Store the recovery codes offline. Never paste them anywhere.
6. Profile → name "Familista Automation"; bio "Machine account for automated development of bibokh/familista-backend. Owned by @bibokh."
7. Create no personal access token for it. Claude's connection (§4) is its only credential.

**Permissions.** A personal-account repository has exactly two levels: the owner and collaborators. A collaborator always has write access, and cannot be made an admin.

What write access lets the automation account do:
- create branches and push commits;
- open, update, merge and close pull requests (merge only when the ruleset allows);
- submit reviews;
- read CI results and re-run or dispatch workflows.

What it cannot do, because only the owner can:
- change settings, rulesets, environments, secrets or collaborators;
- read secret values.

Dispatching `deploy` is answered by the owner-only condition (§2). That is the whole set of permissions, and it is the minimum GitHub offers for a personal repository.

## 4. Moving Claude to the automation identity (prepared; awaiting the owner)

Claude's GitHub tools and its git pushes use the GitHub account connected to your claude.ai account at **claude.ai/connect-github**, through the Claude GitHub App installed on the repository. Changing the account you are signed into on github.com does **not** change it; reconnecting does.

1. **Invite.** As `bibokh`: repository Settings → Collaborators → Add people → the automation account.
2. **Accept.** As the automation account, accept the invitation. Settings → Collaborators should now show it as a collaborator.
3. **App access.** As `bibokh`: Settings → GitHub Apps (Applications → Installed GitHub Apps) → Claude → confirm it is installed on `familista-backend`. The automation account's access works through this installation.
4. **Reconnect.**
   - In a browser profile signed into github.com as the automation account, and signed into **your** claude.ai account, open claude.ai/connect-github.
   - Connect or authorize. This replaces the GitHub identity Claude uses.
   - Keep your normal `bibokh` browser session: reconnecting `bibokh` there is the rollback.
   - The connection belongs to your claude.ai account, so it applies to every repository Claude reaches through it. Give the automation account access to any other repository you want Claude to work on.
5. **Verify** in a new Claude session. Ask it to report each of these:
   - the authenticated user, which must be the automation account and not `bibokh`;
   - the repository collaborators, where the automation account must have the write role;
   - that it can push a branch and open a draft pull request, which shows as authored by the automation account;
   - that it is refused when it asks for the ruleset's administration endpoints or tries to change them.

   Any mismatch means rollback (step 4 with `bibokh`) and stop.
6. **Remove the old access.** As `bibokh`: GitHub Settings → Applications → Authorized GitHub Apps → Claude → **Revoke**.
   - This revokes `bibokh`'s user authorization, not the app's installation on the repository.
   - Do this only after step 5 passed.
   - Afterwards, nothing Claude holds is `bibokh`.

## 5. Environments and Actions settings (prepared; awaiting the owner)

This is safe to do before or after §4, and it does not interrupt deploys if done in this order:

1. **Merge the pull request that carries this file.** The first deploy after it runs in a `production` environment. GitHub creates the environment if it does not exist, and the repository secret still reaches the job.
2. **Settings → Environments → `production`:**
   - Deployment branches and tags → **Selected branches and tags** → add `main`.
   - Environment secrets → add `RENDER_DEPLOY_HOOK_URL` (the same value; Render → service → Settings → Deploy Hook).
   - Do **not** add required reviewers, or every automatic deploy would wait for a click.
3. **Settings → Environments → `backup`:** the same, with `BACKUP_TRIGGER_SECRET`.
4. **Settings → Secrets and variables → Actions → Repository secrets:** delete `RENDER_DEPLOY_HOOK_URL` and `BACKUP_TRIGGER_SECRET` once the next deploy and the next backup succeed from the environments.
5. **Settings → Environments → `restore-drill`:** confirm the deployment branches are `main` only, as the workflow states.
6. **Settings → Actions → General → Workflow permissions:**
   - **Read repository contents and packages permissions**;
   - **Allow GitHub Actions to create and approve pull requests: unchecked**. This is GitHub's default for personal repositories. Confirm it, because a workflow token that can approve pull requests is a review bypass.

## 6. The ruleset (prepared; apply only after §4 is verified)

The exact configuration is `docs/security/ruleset-25019943.proposed.json`. It is today's ruleset with five changes:

| Setting | Today | Proposed |
|---|---|---|
| Require a pull request before merging | on | on |
| Required approvals | 0 | **1** |
| Dismiss stale pull request approvals when new commits are pushed | off | **on** |
| Require review from Code Owners | off | **on** |
| Require approval of the most recent reviewable push | off | **on** |
| Require conversation resolution | on | on |
| Require status checks to pass | 4 checks, GitHub Actions | 4 checks, GitHub Actions |
| Require branches to be up to date before merging | off | **on** |
| Block force pushes | on | on |
| Restrict deletions | on | on |
| Bypass list | empty (unverified) | **empty**: confirm nothing is listed, in particular not "Repository admin", "Write" or any app |
| Allowed merge methods | merge, squash, rebase | unchanged |

Apply it in Settings → Rules → Rulesets → "Familista Main Protection", by hand, as `bibokh`.

**Why after §4.** Once code-owner review is required, a pull request authored by `bibokh` can no longer merge: its only code owner is its author, and GitHub never counts an author's approval of their own pull request. While Claude still acts as `bibokh`, the ruleset would stop all development.

**How the rules apply to each actor:**

| Actor | What the rules mean for them |
|---|---|
| Automation account (write) | Opens pull requests. Needs `bibokh`'s approval as code owner, and all four checks, to merge. A push after the approval dismisses it and needs a new one. It cannot push to main, force-push, delete main or touch the ruleset. Its own approval of its own pull request is never counted. |
| `bibokh` (owner) | Approves as code owner and merges. Its own pull requests cannot satisfy code-owner review (see Limitations). Always able to change the ruleset. |
| GitHub Actions token | Read-only in every workflow. Cannot approve if the Actions setting in §5 is off. |
| Anyone else | No write access; pull requests from forks are subject to the same rules. |

## 7. Limitations: what this does not do

- **The owner can always change the rules.**
  - `bibokh` is the repository's owner. An owner can edit or disable the ruleset, add a bypass actor, change environments and secrets, and change collaborators, at any time.
  - Review enforcement constrains merging, not the administration of the rules themselves.
  - The ruleset's history is the record of such changes. The defence of that account is its own: 2FA, a passkey, and no Claude connection after §4.
- **Bypass actors cannot be verified by CI.** GitHub does not disclose bypass actors to an unauthenticated reader or to the CI token. The gate reports this as UNVERIFIED, never as passed. Only the owner, in the ruleset page, can confirm the list is empty.
- **Owner-authored pull requests cannot merge** under this ruleset (see §6). Changes go through the automation account. For an emergency, the owner may edit the ruleset, which is recorded, or add "Repository admin" with "For pull requests only" as a bypass actor. Either is an owner action and an exception to record.
- **A push by the owner to the automation's branch.**
  - Last-push approval then requires someone other than the owner.
  - Prefer review suggestions that the automation applies, so the owner stays the approver of the last push.
- **Personal-account repository limits:**
  - no teams;
  - no organization rulesets;
  - no custom or read-only roles;
  - no team "required reviewers" by path;
  - no push rulesets or file-path restrictions;
  - no merge queue.

  Moving to a free organization would add some of these. It is not needed for this arrangement.
- **Plan.** The public repository is what makes environment branch rules and environment secrets free. If the repository is made private on GitHub Free, environment secrets stop being available to its workflows. Revisit this file before any visibility change.
- **The approval proves who clicked, not what they read.** The owner's review is a human control; the gates in CI are its evidence.

## 8. Verification (what was verified, and what the owner runs after §4–§6)

**Verified now (read-only, and by tests in this repository):**
- the current ruleset does not enforce review (§1);
- the publication gate on main reports "owner approval enforced: NO" and would refuse any publication;
- the proposed ruleset passes the gate's check, and each requirement withdrawn alone fails it;
- CODEOWNERS ownership of every sensitive path;
- the workflows' read-only tokens, environment-scoped secrets and owner-only manual deploy.

**After §4–§6, with one harmless pull request** (for example a one-line wording fix to this file), opened by the automation account:

| # | Action | Expected |
|---|---|---|
| A | Automation opens the PR; CI passes; nobody approves | Merge blocked: "Review required" and "code owner review required" |
| B | `bibokh` approves | The approval counts, and the merge is allowed. An approval by the automation account itself is not offered (author). |
| C | Automation pushes a commit that breaks a test; `bibokh` approves that very commit | Merge stays blocked by the failing required check, approval or not |
| D | Automation pushes a fixing commit after `bibokh` approved | The approval is dismissed; merge blocked until `bibokh` approves the new push |
| E1 | Automation tries `git push origin HEAD:main` | Rejected: changes must be made through a pull request |
| E2 | Automation tries a force push or deleting `main` | Rejected |
| E3 | Automation runs the `deploy` workflow by hand | The run starts and its job is **skipped**: not the Platform Owner |
| E4 | Automation asks the API to change ruleset 25019943 | Refused: not an admin |
| F | A PR adds a LAB publication | The publication gate replays it, and before the ruleset is applied it fails `owner-approval-enforced`. After the ruleset is applied, it still needs `bibokh`'s code-owner approval to merge. Use a scratch clone, as in PR #141, and do not publish a real dossier to verify this. |

**Independent evidence:** every CI run prints the gate's reading of the rules on main. After §6 it must show every requirement MET, except the UNVERIFIED bypass line.

## 9. The owner's actions, in order

1. Review and merge the pull request carrying this file. It changes no setting.
2. §5: environments `production` and `backup` (main only), move the two secrets, confirm the Actions settings. Then delete the repository-level copies once a deploy and a backup succeed.
3. §3: create the machine account by hand, with 2FA.
4. §4 steps 1–5: invite, accept, check the app installation, reconnect Claude, verify. Roll back if anything differs.
5. §6: apply the ruleset changes and confirm the bypass list is empty.
6. §8: run scenarios A–E with one harmless pull request. F stays verified by CI and tests.
7. §4 step 6: revoke `bibokh`'s Claude authorization.

After that, the first LAB publication can go through its own pull request. It is opened by the automation account, gated by replay, and approved by `bibokh`.
