# GitHub Actions Dependency Submission

![Linter](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/linter.yml/badge.svg)
![CI](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/ci.yml/badge.svg)
![Check dist/](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/check-dist.yml/badge.svg)
![CodeQL](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/github-code-scanning/codeql/badge.svg)
![Coverage](./badges/coverage.svg)

A GitHub Action that scans your repository's workflow files and submits action
dependencies to GitHub's Dependency Graph with fork traversal support.

## Features

- 🔍 **Automatic Workflow Scanning**: Scans `.github/workflows` directory for
  GitHub Actions dependencies
- 📦 **Composite Actions**: Recursively scans local composite actions for nested
  dependencies
- 🔄 **Callable Workflows**: Detects and processes callable workflows referenced
  from workflows
- 🎯 **Additional Paths**: Supports scanning custom directories for composite
  actions and callable workflows
- 🔀 **Fork Traversal**: Detects forked actions and submits both the fork and
  original repository as dependencies
- 🔗 **GitHub API Integration**: Uses GitHub's fork relationship to find
  original repositories
- 🎯 **Regular Expression Pattern Matching**: Supports custom regular expression
  patterns for repositories without fork relationships (e.g., EMU or GitHub-DR)
- 📊 **Dependency Graph Integration**: Submits dependencies to GitHub's
  Dependency Graph for security advisory tracking

## Usage

### Basic Usage

```yaml
name: Submit Dependencies
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 0 * * 0' # Weekly

jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Required for dependency submission
    steps:
      - uses: actions/checkout@v4
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### With Fork Organization Support

If your enterprise uses forked actions (e.g., `myenterprise/actions-checkout` as
a fork of `actions/checkout`):

```yaml
- uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    fork-organizations: 'myenterprise,myorg'
```

This will submit both `myenterprise/actions-checkout` and the original
`actions/checkout` as dependencies, ensuring security advisories for the
original repository also apply to your fork.

### With Custom Regular Expression Pattern

For cases where fork relationships don't exist (e.g., EMU or GitHub-DR
environments):

```yaml
- uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    fork-organizations: 'myenterprise'
    fork-regex: '^myenterprise/(?<org>[^_]+)_(?<repo>.+)'
```

The regular expression must contain named captures `org` and `repo` to identify
the original repository. In this example:

- `myenterprise/actions_checkout` would resolve to `actions/checkout`
- This is useful when forks follow a naming convention but don't have GitHub
  fork relationships

### With Additional Paths for Composite Actions

If you store composite actions or callable workflows in custom directories:

```yaml
- uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    additional-paths: |
      .github/actions
      custom/workflows
      shared/actions
```

This will:

- Scan the specified directories for composite actions (identified by
  `runs.using: composite`)
- Recursively extract dependencies from those composite actions
- Include dependencies from callable workflows (identified by
  `on.workflow_call`)
- Process local action references (e.g., `uses: ./local-action`) in workflows

### For EMU, GitHub-DR, or GHES Environments

If you're running on GitHub Enterprise Managed Users (EMU), GitHub Disaster
Recovery (GitHub-DR), or GitHub Enterprise Server (GHES), and your workflows
reference actions from public GitHub that aren't mirrored to your instance:

```yaml
jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Required for dependency submission
    steps:
      - uses: actions/checkout@v4
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fork-organizations: 'myenterprise'
          public-github-token: ${{ secrets.PUBLIC_GITHUB_TOKEN }}
```

This configuration:

- Uses `token` to access your local GitHub instance and submit dependencies
- Uses `public-github-token` to look up actions on public GitHub
  (api.github.com) when they're not found on your local instance
- Automatically determines whether each action lives on your local instance or
  public GitHub
- Caches the location decision to minimize API calls
- Resolves fork relationships and SHA-to-version mappings from the appropriate
  source

**Note:** The `public-github-token` requires `contents: read` permission for
accessing public repositories on GitHub.com. See the
[environment-specific documentation](#environment-specific-documentation) for
detailed setup instructions for different token types.

## Inputs

| Input                 | Description                                                                                                                                      | Required | Default                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------- |
| `token`               | GitHub token for API access and dependency submission                                                                                            | Yes      | `${{ github.token }}`      |
| `repository`          | Repository to submit dependencies for (owner/repository format)                                                                                  | No       | `${{ github.repository }}` |
| `workflow-directory`  | Directory containing workflow files to scan                                                                                                      | No       | `.github/workflows`        |
| `additional-paths`    | Additional paths to scan for composite actions and callable workflows (comma-separated or newline-separated)                                     | No       | -                          |
| `fork-organizations`  | Comma-separated list of organization names that contain forked actions                                                                           | No       | -                          |
| `fork-regex`          | Regular expression pattern to transform forked repository names. Must contain named captures `org` and `repo`                                    | No       | -                          |
| `public-github-token` | GitHub token for accessing public GitHub (api.github.com) when running on EMU, GitHub-DR, or GHES. Used to look up actions not on local instance | No       | -                          |

## Outputs

| Output             | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `dependency-count` | Number of dependencies submitted to the Dependency Graph |

## How It Works

1. **Workflow Scanning**: The action scans all `.yml` and `.yaml` files in the
   specified workflow directory
1. **Dependency Extraction**: Parses each workflow file to extract `uses:`
   statements that reference GitHub Actions
1. **Local Action Processing**: Detects local action references (e.g.,
   `uses: ./local-action`):
   - Resolves the path relative to the workflow file
   - Checks if it's a composite action
   - Recursively extracts dependencies from the composite action
1. **Callable Workflow Processing**: Detects callable workflow references (e.g.,
   `uses: ./workflow.yml` at job level):
   - Processes the callable workflow
   - Extracts all action dependencies from it
1. **Additional Paths Scanning**: If specified, scans additional directories for
   composite actions:
   - Finds all YAML files in the specified paths
   - Processes composite actions found there
   - Recursively extracts their dependencies
1. **Fork Detection**: For actions from organizations in the
   `fork-organizations` list:
   - First tries to apply the `fork-regex` pattern if provided
   - Falls back to checking GitHub's fork relationship via the API
1. **EMU/DR/GHES Support**: When `public-github-token` is provided:
   - Determines whether each action repository exists on the local GitHub
     instance or public GitHub
   - Caches this decision to avoid redundant API calls
   - Uses the appropriate API endpoint for all subsequent operations on that
     repository
   - Enables looking up fork relationships and SHA-to-version mappings from
     public GitHub when needed
1. **Dependency Submission**: Submits all dependencies to GitHub's Dependency
   Graph:
   - For forked actions, submits both the fork and original repository
   - Uses Package URL (purl) format: `pkg:github/{owner}/{repo}@{ref}`
1. **Security Advisories**: GitHub automatically matches submitted dependencies
   against its security advisory database

## Why Use This Action?

When you use forked GitHub Actions in your workflows, GitHub's Dependabot and
security advisories only track the fork, not the original repository. This
means:

- Security vulnerabilities in the original action won't trigger alerts for your
  fork
- You won't be notified when the original action has security updates

This action solves this problem by submitting both repositories as dependencies,
ensuring you receive security advisories for both the fork and the original.

## Example Use Case

Your enterprise has forked `actions/checkout` to `myenterprise/actions-checkout`
for additional security controls. Your workflows use:

```yaml
- uses: myenterprise/actions-checkout@v4
```

Without this action, you only get security advisories for
`myenterprise/actions-checkout`. With this action configured, you'll receive
advisories for both:

- `myenterprise/actions-checkout@v4`
- `actions/checkout@v4`

## Permissions

The action requires the following permissions:

```yaml
jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Required for dependency submission
    steps:
      # ... your steps
```

**Important Notes:**

- Always define permissions at the **job level**, not at the workflow level, to
  follow the principle of least privilege
- The primary `token` requires `contents: write` permission to submit
  dependencies
- If your workflows reference **private or internal actions** in other
  repositories, you must configure repository access settings. See
  [Allowing access to components in a private repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#allowing-access-to-components-in-a-private-repository)
- The optional `public-github-token` (for EMU/DR/GHES) requires `contents: read`
  permission for public repositories on GitHub.com

For detailed guidance on token permissions for different environments, see the
[Environment-Specific Documentation](#environment-specific-documentation).

## Environment-Specific Documentation

For detailed configuration instructions, token setup, and best practices
specific to your environment, please refer to the appropriate guide:

- **[GitHub Public / GitHub Enterprise Cloud](docs/github-public.md)** -
  Standard GitHub.com and GHEC environments
- **[GitHub Enterprise Managed Users (EMU)](docs/github-emu.md)** - EMU
  environments with forked actions
- **[GitHub Disaster Recovery (GitHub-DR)](docs/github-dr.md)** - GitHub-DR
  environments with action synchronization
- **[GitHub Enterprise Server (GHES)](docs/github-ghes.md)** - Self-hosted GHES
  instances

Each guide covers:

- ✅ Using workflow tokens (`GITHUB_TOKEN`)
- ✅ Using GitHub App tokens (recommended for cross-repository access)
- ✅ Using personal access tokens (with security warnings)
- ✅ Required permissions for each token type
- ✅ Handling private and internal actions
- ✅ Complete working examples
- ✅ Advantages and disadvantages of each approach
- ✅ Environment-specific considerations

## Development

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

1. Run tests:

   ```bash
   npm test
   ```

1. Bundle the action:

   ```bash
   npm run bundle
   ```

### Testing

The action includes comprehensive unit tests for:

- Workflow file parsing
- Fork resolution via GitHub API
- Regular expression pattern matching
- Dependency submission

Run tests with coverage:

```bash
npm run all
```

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
