# GitHub Disaster Recovery (GitHub-DR)

This guide covers using the `actions-dependency-submission` action on GitHub
Disaster Recovery (GitHub-DR) environments.

## Overview

GitHub-DR environments typically have forked actions from public GitHub
(github.com) that have been synchronized to your DR instance. This action needs:

1. A token with `contents: write` permission to submit dependencies to your
   GitHub-DR instance
2. Optionally, a token with `contents: read` permission to public GitHub to look
   up original repositories for forked actions
3. If your workflows reference private or internal actions, the primary token
   needs `contents: read` permission on those repositories

## Token Options

### Primary Token (Required)

The primary token is used to submit dependencies and access your GitHub-DR
instance.

#### Option 1: Workflow Token (Recommended for GitHub-DR)

The built-in `GITHUB_TOKEN` is the simplest and most secure option.

##### Example

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
          fork-organizations: 'myorg-dr'
```

##### Advantages

- ✅ **Automatic**: No setup required, automatically available
- ✅ **Secure**: Token is scoped to the workflow run and expires automatically
- ✅ **No maintenance**: No need to rotate or manage credentials
- ✅ **Audit trail**: Actions are attributed to the GitHub Actions bot

##### Disadvantages

- ❌ **Repository scoped**: Cannot access private/internal actions in other
  repositories by default
- ❌ **No public GitHub access**: Cannot look up actions on public GitHub

##### When to Use

Use the workflow token when:

- Your forked actions follow a naming convention (use `fork-regex`)
- You only use actions synchronized to your GitHub-DR instance
- Your workflows only use local composite actions within the same repository

##### Additional Configuration for Private/Internal Actions

If your workflows reference private or internal actions in other repositories,
configure access via
[Allowing access to components in a private repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#allowing-access-to-components-in-a-private-repository).

The `GITHUB_TOKEN` will automatically have `contents: read` access to those
repositories.

---

#### Option 2: GitHub App Token

A GitHub App provides flexibility for accessing multiple repositories and better
audit trails.

##### Setup

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
   in your GitHub-DR organization
2. Configure the app with these permissions:
   - **Repository permissions**:
     - Contents: Read and Write
3. Install the app on:
   - The repository where you're submitting dependencies
   - Any repositories containing private/internal actions you reference
4. Note the App ID and generate a private key

##### Example

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
      contents: read # Only needed if checking out code
    steps:
      - uses: actions/checkout@v4

      - name: Generate token
        id: generate-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          repositories: |
            my-repo
            my-private-actions

      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ steps.generate-token.outputs.token }}
          fork-organizations: 'myorg-dr'
```

##### Advantages

- ✅ **Organization-wide**: Can be installed across multiple repositories
- ✅ **Fine-grained permissions**: Limit access to specific repositories
- ✅ **Better audit trail**: Actions are attributed to the app
- ✅ **No user account dependency**: Not tied to a specific user
- ✅ **Cross-repository access**: Can access private/internal actions

##### Disadvantages

- ⚠️ **Setup complexity**: Requires creating and configuring a GitHub App
- ⚠️ **Key management**: Need to securely store app private key
- ⚠️ **No public GitHub access**: Cannot look up actions on public GitHub

##### When to Use

Use a GitHub App token when:

- You need to access multiple repositories
- Your workflows reference private/internal actions in other repositories
- You want better audit trails
- You need organization-wide dependency submission

---

#### Option 3: Personal Access Token

A personal access token can be used when GitHub Apps are not an option.

##### Setup

1. Create a
   [Fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
   (recommended)
2. Configure with:
   - Repository access: Select repositories or all repositories
   - Permissions:
     - Contents: Read and Write
3. Store as a repository secret (e.g., `DEPENDENCY_SUBMISSION_TOKEN`)

##### Example

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
      contents: read # Only needed if checking out code
    steps:
      - uses: actions/checkout@v4
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.DEPENDENCY_SUBMISSION_TOKEN }}
          fork-organizations: 'myorg-dr'
```

##### Advantages

- ✅ **Simple setup**: Easy to create and configure
- ✅ **Flexible**: Can access multiple repositories
- ✅ **Cross-repository access**: Can access private/internal actions

##### Disadvantages

- ⚠️ **Security risk**: Long-lived, doesn't expire automatically
- ⚠️ **User-dependent**: Tied to a specific user account
- ⚠️ **Manual rotation**: Must be manually rotated
- ⚠️ **No public GitHub access**: Cannot look up actions on public GitHub

⚠️ **Security Warning**: Personal access tokens are less secure than GitHub Apps.
Consider using a GitHub App token instead.

---

### Public GitHub Token (Optional)

When your GitHub-DR instance has forked actions without maintaining GitHub fork
relationships, you need a token to look up the original repositories on public
GitHub (github.com).

#### Setup Options

##### Option A: GitHub App Token for Public GitHub (Recommended)

Create a separate GitHub App on public GitHub (github.com) for looking up action
repositories.

###### Setup

1. Create a GitHub App on public GitHub (github.com)
2. Configure with minimal permissions:
   - **Repository permissions**:
     - Contents: Read (for public repositories)
     - Metadata: Read (automatically included)
3. Install the app on public repositories you need to access (or make it public)
4. Store the App ID and private key as secrets

###### Example

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

      - name: Generate public GitHub token
        id: generate-public-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.PUBLIC_GITHUB_APP_ID }}
          private-key: ${{ secrets.PUBLIC_GITHUB_APP_PRIVATE_KEY }}
          # This app is on public GitHub, not your DR instance
          github-api-url: https://api.github.com

      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fork-organizations: 'myorg-dr'
          public-github-token: ${{ steps.generate-public-token.outputs.token }}
```

###### Advantages

- ✅ **Secure**: Short-lived tokens that auto-expire
- ✅ **Fine-grained**: Only needs read access to public repositories
- ✅ **Better audit trail**: Actions attributed to the app
- ✅ **Automatic rotation**: Tokens are generated on-demand

###### Disadvantages

- ⚠️ **Setup complexity**: Requires creating an app on public GitHub
- ⚠️ **Key management**: Need to securely store app private key
- ⚠️ **Additional step**: Requires an extra workflow step

---

##### Option B: Personal Access Token for Public GitHub

Create a personal access token on public GitHub (github.com) for read-only
access to public repositories.

###### Setup

1. Create a
   [Fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
   on public GitHub (github.com)
2. Configure with:
   - Repository access: Public Repositories (read-only)
   - Permissions:
     - Contents: Read
     - Metadata: Read
3. Store as a repository secret (e.g., `PUBLIC_GITHUB_TOKEN`)

###### Example

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
          fork-organizations: 'myorg-dr'
          public-github-token: ${{ secrets.PUBLIC_GITHUB_TOKEN }}
```

###### Advantages

- ✅ **Simple setup**: Easy to create
- ✅ **Read-only access**: Limited to reading public repositories

###### Disadvantages

- ⚠️ **Security risk**: Long-lived token that doesn't expire automatically
- ⚠️ **User-dependent**: Tied to a personal GitHub.com account
- ⚠️ **Manual rotation**: Must be manually rotated
- ⚠️ **Audit trail**: Actions attributed to the user

⚠️ **Security Warning**: Personal access tokens are less secure because they:

- Don't expire automatically
- Are tied to a user account
- Must be manually rotated
- Can be used indefinitely if compromised

**Recommendation**: Use a GitHub App token instead for better security.

---

## Complete Examples

### Example 1: GitHub-DR with Workflow Token and Regex Pattern

Best for when forked actions follow a naming convention and you don't need to
look up actions on public GitHub.

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
          fork-organizations: 'myorg-dr'
          fork-regex: '^myorg-dr/(?<org>[^_]+)_(?<repo>.+)'
```

In this example:

- `myorg-dr/actions_checkout` resolves to `actions/checkout`
- No public GitHub token needed because the regex pattern handles resolution

---

### Example 2: GitHub-DR with GitHub App Tokens (Most Secure)

Best for production environments requiring maximum security and audit trails.

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
      contents: read # Only needed for checkout
    steps:
      - uses: actions/checkout@v4

      - name: Generate DR token
        id: generate-dr-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.DR_APP_ID }}
          private-key: ${{ secrets.DR_APP_PRIVATE_KEY }}

      - name: Generate public GitHub token
        id: generate-public-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.PUBLIC_GITHUB_APP_ID }}
          private-key: ${{ secrets.PUBLIC_GITHUB_APP_PRIVATE_KEY }}
          github-api-url: https://api.github.com

      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ steps.generate-dr-token.outputs.token }}
          fork-organizations: 'myorg-dr'
          public-github-token: ${{ steps.generate-public-token.outputs.token }}
```

---

### Example 3: GitHub-DR with Mixed Tokens

Workflow token for GitHub-DR, GitHub App for public GitHub lookups.

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

      - name: Generate public GitHub token
        id: generate-public-token
        uses: actions/create-github-app-token@v1
        with:
          app-id: ${{ secrets.PUBLIC_GITHUB_APP_ID }}
          private-key: ${{ secrets.PUBLIC_GITHUB_APP_PRIVATE_KEY }}
          github-api-url: https://api.github.com

      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          fork-organizations: 'myorg-dr'
          public-github-token: ${{ steps.generate-public-token.outputs.token }}
```

---

## Permissions Summary

| Token                  | Purpose                        | Minimum Permissions               |
| ---------------------- | ------------------------------ | --------------------------------- |
| Primary Token          | Submit dependencies to DR      | `contents: write`                 |
| Primary Token          | Access private/internal actions| `contents: read` (automatic)      |
| Public GitHub Token    | Look up actions on GitHub.com  | `contents: read` (public repos)   |

## Best Practices

1. **Always define permissions at the job level** for least privilege
2. **Use GitHub Apps** for both tokens when possible for maximum security
3. **Use regex patterns** when available to avoid needing a public GitHub token
4. **Regularly audit** public GitHub token usage and permissions
5. **Document** your fork naming conventions if using regex patterns
6. **Monitor** for actions that cannot be resolved and may need manual mapping
7. **Test failover scenarios** to ensure dependency submission works during DR
   events
8. **Configure access** to private/internal action repositories via repository
   settings

## GitHub-DR Specific Considerations

### Synchronization

- Ensure your DR environment regularly synchronizes with primary GitHub instance
- Verify that forked actions are up-to-date in your DR environment
- Test dependency submission in both primary and DR environments

### Network Connectivity

- GitHub-DR environments may have restricted network access to public GitHub
- Ensure runners can reach api.github.com if using a public GitHub token
- Consider using regex patterns if public GitHub access is restricted

### Failover Testing

- Regularly test dependency submission during DR drills
- Verify that all tokens and apps work in DR environment
- Document any DR-specific configuration requirements

## Documentation

- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)
- [Managing Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
