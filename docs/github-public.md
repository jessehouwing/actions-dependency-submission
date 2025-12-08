# GitHub Public / GitHub Enterprise Cloud

This guide covers using the `actions-dependency-submission` action on GitHub
Public (github.com) or GitHub Enterprise Cloud (GHEC).

## Overview

On GitHub Public and GHEC, you need a token with `contents: write` permission to
submit dependencies to the Dependency Graph. Additionally, if your workflows
reference private or internal actions, the token needs `contents: read`
permission on those repositories.

## Token Options

### Option 1: Workflow Token (Recommended)

The built-in `GITHUB_TOKEN` is the simplest and most secure option for most use
cases.

#### Workflow Token Example

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

#### Workflow Token Advantages

- ✅ **Automatic**: No setup required, automatically available in all workflows
- ✅ **Secure**: Token is scoped to the workflow run and expires automatically
- ✅ **No maintenance**: No need to rotate or manage credentials
- ✅ **Audit trail**: Actions are attributed to the GitHub Actions bot
- ✅ **Best practice**: Recommended by GitHub for most automation tasks

#### Workflow Token Disadvantages

- ❌ **Repository scoped**: Cannot access private/internal actions in other
  repositories by default
- ❌ **Limited lifetime**: Token expires when the workflow completes
- ❌ **No cross-repository access**: Cannot read from repositories outside the
  current workflow's repository without additional configuration

#### When to Use Workflow Token

Use the workflow token when:

- Your workflows only use public actions
- Your workflows only use local composite actions within the same repository
- You want the simplest, most secure setup

#### Additional Configuration for Private/Internal Actions

If your workflows reference private or internal actions in other repositories,
you need to grant the workflow access to those repositories. See
[Allowing access to components in a private repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository#allowing-access-to-components-in-a-private-repository).

Once configured, update the permissions:

```yaml
jobs:
  submit-dependencies:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Required for dependency submission to current repository
    steps:
      - uses: actions/checkout@v4
      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

**Note**: Once you configure access to private/internal action repositories via
the repository settings, the `GITHUB_TOKEN` will have `contents: read` access to
those repositories.

---

### Option 2: GitHub App Token

A GitHub App provides more flexibility and better security than personal access
tokens, with fine-grained permissions and better audit trails.

#### GitHub App Setup

1. [Create a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
   for your organization or account
1. Configure the app with these permissions:
   - **Repository permissions**:
     - Contents: Read and Write
1. Install the app on:
   - The repository where you're submitting dependencies
   - Any repositories containing private/internal actions you reference
1. Note the App ID and generate a private key

#### GitHub App Example

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
          # If you need access to multiple repositories (e.g., for private actions)
          repositories: |
            my-repo
            my-private-actions
            my-internal-actions

      - uses: jessehouwing/actions-dependency-submission@v1
        with:
          token: ${{ steps.generate-token.outputs.token }}
```

**Note**: When accessing private/internal actions across multiple repositories,
include all relevant repository names in the `repositories` input. The generated
token will have the permissions configured in the GitHub App for the listed
repositories. Ensure the app has `contents: read` permission for repositories
containing private/internal actions and `contents: write` permission for the
repository where dependencies are being submitted.

#### GitHub App Advantages

- ✅ **Organization-wide**: Can be installed across multiple repositories
- ✅ **Fine-grained permissions**: Can limit access to specific repositories and
  permissions
- ✅ **Better audit trail**: Actions are attributed to the app, not a user
- ✅ **No user account dependency**: Not tied to a specific user's account
- ✅ **Automatic expiration**: Tokens are short-lived and auto-expire
- ✅ **Scalable**: Works across multiple repositories and organizations
- ✅ **Cross-repository access**: Can access private/internal actions in other
  repositories where the app is installed

#### GitHub App Disadvantages

- ⚠️ **Setup complexity**: Requires creating and configuring a GitHub App
- ⚠️ **Key management**: Need to securely store app private key
- ⚠️ **Administrative access**: Requires organization admin rights to create the
  app
- ⚠️ **Additional step**: Requires an extra step in the workflow to generate the
  token

#### When to Use GitHub App

Use a GitHub App token when:

- You need to access multiple repositories
- You want better audit trails than a personal access token
- You need to submit dependencies across an organization
- Your workflows reference private/internal actions in other repositories
- You want to avoid tying automation to a specific user account

#### GitHub App Documentation

- [Creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [Authenticating with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [actions/create-github-app-token](https://github.com/actions/create-github-app-token)

---

### Option 3: Personal Access Token (Classic or Fine-Grained)

A personal access token can be used when GitHub Apps are not an option, but this
is generally less secure and harder to maintain.

#### PAT Setup

1. Create a
   [Fine-grained Personal Access Token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)
   (recommended) or
   [Personal Access Token (Classic)](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-personal-access-token-classic)
1. Configure the token with these permissions:
   - Fine-grained token:
     - Repository access: Select repositories or all repositories
     - Permissions:
       - Contents: Read and Write
   - Classic token:
     - Scope: `repo` (Full control of private repositories)
1. Store the token as a repository secret (e.g., `DEPENDENCY_SUBMISSION_TOKEN`)

#### PAT Example

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
```

**Note**: When using a personal access token, ensure it has access to all
repositories containing private/internal actions that your workflows reference.
The token will have `contents: read` access to those repositories automatically.

#### PAT Advantages

- ✅ **Simple setup**: Easy to create and configure
- ✅ **Flexible**: Can access multiple repositories and organizations
- ✅ **Works everywhere**: Compatible with all GitHub deployments
- ✅ **Cross-repository access**: Can access private/internal actions in other
  repositories

#### PAT Disadvantages

- ⚠️ **Security risk**: Tokens are long-lived and don't expire automatically
- ⚠️ **User-dependent**: Tied to a specific user account
- ⚠️ **Broad permissions**: Classic tokens often have more permissions than
  needed
- ⚠️ **Manual rotation**: Must be manually rotated and updated
- ⚠️ **Audit trail**: Actions are attributed to the user, not a service account
- ⚠️ **Account dependency**: If the user leaves or is deactivated, the token
  stops working
- ⚠️ **Less secure**: Compromised token can be used indefinitely until revoked

#### When to Use PAT

Use a personal access token only when:

- GitHub Apps are not available or cannot be used
- You need a quick temporary solution
- You understand and accept the security implications

⚠️ **Security Warning**: Personal access tokens are less secure than GitHub Apps
because they:

- Don't expire automatically
- Are tied to a user account (which may be deactivated)
- Often have broader permissions than necessary
- Cannot be easily audited or monitored

Consider using a GitHub App token instead for better security and
maintainability.

#### PAT Documentation

- [Managing Personal Access Tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Creating a fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token)

---

## Permissions Summary

| Token Type      | Minimum Permissions for Current Repository | Access to Private/Internal Actions                 |
| --------------- | ------------------------------------------ | -------------------------------------------------- |
| Workflow Token  | `contents: write`                          | Requires repository configuration + automatic read |
| GitHub App      | `contents: write`                          | Automatic `contents: read` where app is installed  |
| Personal Access | `contents: write`                          | Automatic `contents: read` based on token scope    |

## Best Practices

1. **Always define permissions at the job level**, not at the workflow level, to
   follow the principle of least privilege
1. **Prefer the workflow token** (`GITHUB_TOKEN`) when possible for maximum
   security
1. **Use GitHub Apps** when you need cross-repository access or
   organization-wide automation
1. **Avoid personal access tokens** unless absolutely necessary due to security
   concerns
1. **Regularly audit** which repositories have access to your private/internal
   actions
1. **Document** which repositories your workflows depend on for private/internal
   actions
