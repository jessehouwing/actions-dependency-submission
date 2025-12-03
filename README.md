# Actions Dependency Submission

![Linter](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/linter.yml/badge.svg)
![CI](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/ci.yml/badge.svg)
![Check dist/](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/check-dist.yml/badge.svg)
![CodeQL](https://github.com/jessehouwing/actions-dependency-submission/actions/workflows/codeql-analysis.yml/badge.svg)
![Coverage](./badges/coverage.svg)

A GitHub Action that automatically submits GitHub Actions dependencies from
workflows, composite actions, and callable workflows to the GitHub Dependency
Graph using the Dependency Submission API.

## Features

- 🔍 **Comprehensive Scanning**: Automatically scans `.github/workflows`
  directory for workflow files
- 🔄 **Recursive Detection**: Finds and processes local composite actions and
  callable workflows
- 📦 **Nested Dependencies**: Recursively scans dependencies within composite
  actions
- 🎯 **Custom Paths**: Support for additional paths to scan for composite
  actions and callable workflows
- 📊 **Dependency Graph Integration**: Submits all discovered dependencies to
  GitHub's Dependency Graph
- 🔒 **Security Insights**: Enables Dependabot alerts for GitHub Actions
  dependencies

## Usage

Add this action to your workflow to automatically submit your GitHub Actions
dependencies:

```yaml
name: Submit Dependencies

on:
  push:
    branches: [main]
  workflow_dispatch:

# Required permission to submit dependencies
permissions:
  contents: write

jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Submit dependencies
        uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### With Additional Paths

If you have composite actions or callable workflows in custom locations:

```yaml
- name: Submit dependencies
  uses: jessehouwing/actions-dependency-submission@v1
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
    additional-paths: |
      .github/actions
      custom/workflows
      shared/actions
```

## Inputs

| Input              | Description                                                                                        | Required | Default               |
| ------------------ | -------------------------------------------------------------------------------------------------- | -------- | --------------------- |
| `token`            | GitHub token with `contents:write` permission                                                      | Yes      | `${{ github.token }}` |
| `workflow-path`    | Path to the .github/workflows directory                                                            | No       | `.github/workflows`   |
| `additional-paths` | Additional paths to scan for composite actions and callable workflows (comma or newline separated) | No       | `''`                  |

## Outputs

| Output             | Description                                                     |
| ------------------ | --------------------------------------------------------------- |
| `dependency-count` | Number of unique dependencies submitted to the Dependency Graph |

## How It Works

1. **Workflow Scanning**: Scans all YAML files in the workflows directory
2. **Dependency Extraction**: Extracts `uses:` statements from workflow steps
   and jobs
3. **Local Action Detection**: Identifies local composite actions (e.g.,
   `uses: ./path/to/action`)
4. **Callable Workflow Detection**: Identifies callable workflows (e.g.,
   `uses: ./path/to/workflow.yml`)
5. **Recursive Processing**: For each local action/workflow found:
   - Checks if it's a composite action
   - Recursively scans for additional dependencies
   - Processes nested local actions
6. **Additional Paths**: Scans any additional paths provided for composite
   actions
7. **Dependency Submission**: Submits all unique dependencies to GitHub's
   Dependency Graph API

## What Gets Detected

### Remote Actions

- Standard format: `owner/repo@version`
- With path: `owner/repo/path/to/action@version`
- Example: `actions/checkout@v4`, `docker/build-push-action@v5`

### Local Composite Actions

- Relative paths: `./path/to/action`, `../path/to/action`
- Must contain an `action.yml` or `action.yaml` file
- Must have `runs.using: composite`
- Example: `./.github/actions/my-action`

### Callable Workflows

- Relative paths: `./path/to/workflow.yml`
- Must have `on.workflow_call` trigger
- Example: `./.github/workflows/reusable-workflow.yml`

### Docker Actions

Docker-based actions (`docker://`) are intentionally skipped as they don't have
version tracking suitable for dependency graphs.

## Example Scenarios

### Scenario 1: Basic Workflow

A workflow uses `actions/checkout@v4` and `actions/setup-node@v4`. Both
dependencies are detected and submitted.

### Scenario 2: Local Composite Action

A workflow uses a local action at `./.github/actions/build`. The action is
detected, and its internal dependencies (e.g., `actions/cache@v3`) are also
discovered and submitted.

### Scenario 3: Nested Local Actions

A workflow uses a local action that itself references another local action. Both
actions are processed, and all their dependencies are discovered recursively.

### Scenario 4: Callable Workflows

A workflow calls a reusable workflow using
`uses: ./.github/workflows/deploy.yml`. The callable workflow is processed, and
all its action dependencies are discovered.

### Scenario 5: Custom Locations

You store composite actions in a custom `shared/actions` directory. By
specifying this in `additional-paths`, these actions are scanned even if not
directly referenced from workflows.

## Benefits

- **Automated Dependency Tracking**: No manual maintenance of dependency lists
- **Dependabot Integration**: Automatically get Dependabot alerts for outdated
  or vulnerable actions
- **Security Insights**: View all action dependencies in your repository's
  Insights > Dependency graph
- **Supply Chain Security**: Better visibility into your CI/CD pipeline
  dependencies

## Permissions

This action requires the `contents: write` permission to submit dependencies to
the Dependency Graph:

```yaml
permissions:
  contents: write
```

## Troubleshooting

### No dependencies submitted

- Verify the `workflow-path` is correct
- Check that YAML files are valid and contain `uses:` statements
- Ensure the GitHub token has `contents:write` permission

### Local actions not detected

- Verify paths use relative references (`./ or ../`)
- Ensure local actions have `action.yml` or `action.yaml` files
- Check that composite actions have `runs.using: composite`

### API errors

- Verify your repository has the Dependency Graph feature enabled
- Check that the GitHub token is valid and has proper permissions

## Development

### Prerequisites

- Node.js 24.x or later
- npm

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Run tests:

   ```bash
   npm test
   ```

3. Lint code:

   ```bash
   npm run lint
   ```

4. Build the action:
   ```bash
   npm run bundle
   ```

### Project Structure

```
.
├── src/
│   ├── main.ts                    # Entry point
│   ├── dependency-scanner.ts      # Scans for dependencies
│   ├── dependency-submission.ts   # Submits to GitHub API
│   ├── workflow-parser.ts         # Parses YAML files
│   └── types.ts                   # Type definitions
├── __tests__/                     # Unit tests
├── __fixtures__/                  # Test fixtures
└── dist/                          # Compiled JavaScript
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Related Documentation

- [GitHub Dependency Submission API](https://docs.github.com/en/rest/dependency-graph/dependency-submission)
- [About the dependency graph](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-the-dependency-graph)
- [Composite Actions](https://docs.github.com/en/actions/creating-actions/creating-a-composite-action)
- [Reusable Workflows](https://docs.github.com/en/actions/using-workflows/reusing-workflows)

## License

MIT
