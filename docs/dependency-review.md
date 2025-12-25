# Dependency Review Integration

This guide covers how to combine `actions-dependency-submission` with the
[Dependency Review Action](https://github.com/actions/dependency-review-action)
to enforce security policies on pull requests.

## Overview

The **Dependency Review Action** scans pull requests for dependency changes and
can block merges if new dependencies introduce:

- Known security vulnerabilities
- Disallowed licenses
- Dependencies from untrusted sources

When combined with `actions-dependency-submission`, you get comprehensive
security coverage for your GitHub Actions dependencies.

## How It Works

1. **Dependency Submission** (on push and pull request): The
   `actions-dependency-submission` action scans your workflows and submits
   action dependencies to the Dependency Graph for both the base branch and
   pull request head
2. **Dependency Review** (on pull request): The `dependency-review-action`
   compares the dependency graph between the base and head commits, flagging any
   new vulnerabilities or policy violations

**Important:** The dependency submission action must run on pull requests so
that the dependency graph has data for the PR head commit. Without this, the
dependency review action has nothing to compare against.

## Basic Setup

### Step 1: Submit Dependencies on Push and Pull Requests

Ensure dependencies are submitted when changes are pushed to your default
branch **and** on pull requests:

```yaml
# .github/workflows/submit-dependencies.yml
name: Submit Dependencies
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '37 5 * * 0' # Weekly

jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

**Note:** Running on `pull_request` ensures the dependency graph is populated
for the PR head commit, which is required for the dependency review action to
perform its comparison.

### Step 2: Review Dependencies on Pull Requests

Add dependency review to your pull request workflow:

```yaml
# .github/workflows/dependency-review.yml
name: Dependency Review
on: pull_request

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/dependency-review-action@v4
```

## Advanced Configuration

### Configuring Vulnerability Severity Thresholds

Block pull requests based on vulnerability severity:

```yaml
- uses: actions/dependency-review-action@v4
  with:
    fail-on-severity: moderate # Options: low, moderate, high, critical
```

### License Policy Enforcement

Block dependencies with specific licenses:

```yaml
- uses: actions/dependency-review-action@v4
  with:
    deny-licenses: GPL-3.0, AGPL-3.0
    # Or allow only specific licenses:
    # allow-licenses: MIT, Apache-2.0, BSD-3-Clause
```

### Allowing Known Vulnerabilities

If you need to temporarily allow specific vulnerabilities (e.g., while waiting
for a patch):

```yaml
- uses: actions/dependency-review-action@v4
  with:
    allow-ghsas: GHSA-xxxx-xxxx-xxxx, GHSA-yyyy-yyyy-yyyy
```

### Complete Example with All Options

```yaml
name: Dependency Review
on: pull_request

jobs:
  dependency-review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: moderate
          deny-licenses: GPL-3.0, AGPL-3.0
          comment-summary-in-pr: always
          warn-only: false
```

## Enforcing with Branch Rulesets

To ensure dependency review passes before merging, configure a branch ruleset
with required status checks.

### Creating a Branch Ruleset

1. Navigate to **Settings** → **Rules** → **Rulesets** in your repository
2. Click **New ruleset** → **New branch ruleset**
3. Configure the ruleset:
   - **Ruleset name**: `Protect main branch`
   - **Enforcement status**: `Active`
   - **Target branches**: Add your default branch (e.g., `main`)
4. Enable **Require status checks to pass**:
   - Search for and add `dependency-review` (the job name from your workflow)
   - Enable **Require branches to be up to date before merging** (recommended)
5. Click **Create**

### Ruleset Configuration Example

Your ruleset should include:

| Setting                                        | Value                         |
| ---------------------------------------------- | ----------------------------- |
| Target branches                                | `main` (or your default)      |
| Require status checks to pass                  | ✅ Enabled                    |
| Required checks                                | `dependency-review`           |
| Require branches to be up to date before merge | ✅ Enabled (recommended)      |
| Block force pushes                             | ✅ Enabled (recommended)      |
| Require a pull request before merging          | ✅ Enabled (recommended)      |

### Organization-Level Rulesets

For consistent enforcement across multiple repositories, create rulesets at the
organization level:

1. Navigate to your **Organization Settings** → **Rules** → **Rulesets**
2. Create a ruleset targeting all repositories or specific repository patterns
3. Configure the same status check requirements

## Combined Workflow Example

For repositories that want both submission and review in a single workflow file:

```yaml
# .github/workflows/dependencies.yml
name: Dependencies
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '37 5 * * 0'

jobs:
  # Submit dependencies on push, pull request, and schedule
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}

  # Review dependencies on pull requests (after submission completes)
  dependency-review:
    if: github.event_name == 'pull_request'
    needs: submit-dependencies
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/dependency-review-action@v4
        with:
          fail-on-severity: moderate
          comment-summary-in-pr: always
```

**Note:** The `dependency-review` job uses `needs: submit-dependencies` to
ensure the dependency graph is populated before the review runs.

## Enterprise Environments

### EMU, GitHub-DR, and GHES

When using forked actions in enterprise environments, ensure both actions are
configured appropriately:

```yaml
jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fork-organizations: 'myenterprise'
          public-github-token: ${{ secrets.PUBLIC_GITHUB_TOKEN }}

  dependency-review:
    needs: submit-dependencies
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v6
      - uses: actions/dependency-review-action@v4
```

**Note:** The dependency review action uses the same Dependency Graph that
`actions-dependency-submission` populates, so vulnerabilities in both forked and
original actions will be detected.

## Troubleshooting

### Dependency Review Not Finding Action Dependencies

If the dependency review action doesn't detect your action dependencies:

1. Ensure `actions-dependency-submission` runs on **both** `push` to main **and**
   `pull_request` events
2. Verify the submission job completes before the review job runs (use `needs:`
   if in the same workflow)
3. Check that dependencies were submitted by viewing **Insights** → **Dependency
   graph** → **Dependencies** in your repository
4. Verify the workflow trigger includes the correct events

### Status Check Not Appearing in Ruleset

If the `dependency-review` check doesn't appear when configuring your ruleset:

1. Ensure the workflow has run at least once on a pull request
2. Check that the job name matches exactly (case-sensitive)
3. Verify the workflow file is on the default branch

### False Positives from Fork Resolution

If you're getting vulnerability alerts for original repositories that you've
already patched in your fork:

1. Consider setting `report-transitive-as-direct: false` in the dependency
   submission action
2. Use `allow-ghsas` in the dependency review action to suppress specific
   advisories you've addressed

## Best Practices

1. **Run dependency submission on schedule**: Use a weekly cron to ensure the
   dependency graph stays current even without code changes
2. **Enable PR comments**: Set `comment-summary-in-pr: always` for visibility
   into what dependencies changed
3. **Start with warnings**: Use `warn-only: true` initially to understand the
   impact before enforcing
4. **Document exceptions**: When using `allow-ghsas`, document why each
   exception was granted
5. **Review periodically**: Regularly review allowed vulnerabilities and remove
   exceptions when patches are available

## Performance Optimization

### Sparse Checkout for Large Repositories

For very large repositories (multi-GB, many binary files, or LFS content), you
can use sparse checkout to only fetch the files needed:

```yaml
steps:
  - uses: actions/checkout@v6
    with:
      sparse-checkout: |
        .github/workflows
        .github/actions
        action.yml
        action.yaml
      sparse-checkout-cone-mode: false
  - uses: jessehouwing/actions-dependency-submission@v1
    with:
      token: ${{ secrets.GITHUB_TOKEN }}
```

**Note:** For most repositories, a full checkout is fast enough that sparse
checkout adds unnecessary complexity. Only use this optimization when checkout
time is a significant bottleneck.

## Documentation

- [Dependency Review Action](https://github.com/actions/dependency-review-action) -
  Action repository with full configuration options
- [Configuring the Dependency Review Action](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/configuring-the-dependency-review-action) -
  GitHub documentation
- [Require Status Checks to Pass](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging) -
  Branch ruleset documentation
- [About the Dependency Graph](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-the-dependency-graph) -
  Understanding GitHub's dependency tracking
