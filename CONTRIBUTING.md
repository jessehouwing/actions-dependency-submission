# Contributing

Thank you for your interest in contributing to this project!

## Quick Start with Dev Containers / Codespaces

The easiest way to get started is using GitHub Codespaces or VS Code Dev
Containers, which provide a fully configured development environment:

### GitHub Codespaces

1. Click the "Code" button on the repository
2. Select "Open with Codespaces"
3. Create a new codespace

### VS Code Dev Containers

1. Install the
   [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Clone the repository
3. Open in VS Code and click "Reopen in Container" when prompted

The dev container automatically installs:

- Node.js with the correct version
- Ruby with required gems
- CMake for native extensions
- GitHub CLI
- All recommended VS Code extensions

## Manual Setup

If you prefer to set up your environment manually, follow the instructions
below.

### Prerequisites

#### All Platforms

- **Node.js** 24.4.0 (see `.node-version`)
  - Use [nvm](https://github.com/nvm-sh/nvm),
    [fnm](https://github.com/Schniz/fnm), or
    [nodenv](https://github.com/nodenv/nodenv) to manage Node versions
- **Ruby** (for license compliance tooling)
- **CMake** (required for native gem extensions)

#### Windows-Specific Dependencies

On Windows, install the following tools for license compliance checking with the
`licensed` gem:

```powershell
# Install Ruby (if not already installed)
winget install RubyInstallerTeam.Ruby.3.2

# Install CMake (required for native gem extensions)
winget install Kitware.CMake

# Install GNU coreutils (provides standard Unix utilities)
winget install uutils.coreutils

# Install which (required by licensed gem)
winget install GnuWin32.Which
```

> **Note:** After installation, restart your terminal or refresh your
> environment variables:
>
> ```powershell
> $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
> ```

#### macOS Dependencies

```bash
# Install Ruby (if not using system Ruby)
brew install ruby

# Install CMake
brew install cmake
```

#### Linux Dependencies

```bash
# Debian/Ubuntu
sudo apt-get install ruby cmake

# Fedora
sudo dnf install ruby cmake
```

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/jessehouwing/actions-dependency-submission.git
   cd actions-dependency-submission
   ```

2. Install Node.js dependencies:

   ```bash
   npm install
   ```

3. Install Ruby dependencies:

   ```bash
   bundle install
   ```

4. Run tests to verify your setup:

   ```bash
   npm test
   ```

## VS Code Configuration

### Recommended Extensions

The following extensions are recommended for development (also auto-installed in
dev containers):

| Extension                                                                                                                  | Purpose                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)                                       | JavaScript/TypeScript linting  |
| [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)                                     | Code formatting                |
| [GitHub Actions](https://marketplace.visualstudio.com/items?itemName=github.vscode-github-actions)                         | Workflow file support          |
| [YAML](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)                                             | YAML language support          |
| [Markdown All in One](https://marketplace.visualstudio.com/items?itemName=yzhang.markdown-all-in-one)                      | Markdown editing               |
| [markdownlint](https://marketplace.visualstudio.com/items?itemName=davidanson.vscode-markdownlint)                         | Markdown linting               |
| [GitHub Pull Requests](https://marketplace.visualstudio.com/items?itemName=github.vscode-pull-request-github)              | PR integration                 |
| [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=github.copilot)                                       | AI-assisted development        |
| [Markdown Preview GitHub Styles](https://marketplace.visualstudio.com/items?itemName=bierner.markdown-preview-github-styles) | GitHub-style markdown preview  |

### Editor Settings

The project uses Prettier as the default formatter with format-on-save enabled.
VS Code settings are provided in `.vscode/settings.json`.

## Debugging

### Local Action Debugging

This project uses
[@github/local-action](https://github.com/github/local-action) for local
debugging. A VS Code launch configuration is provided.

1. Copy `.env.example` to `.env`:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` to set your inputs and environment variables:

   ```dotenv
   # Enable debug logging
   ACTIONS_STEP_DEBUG=true

   # Set action inputs (use INPUT_<name> format)
   INPUT_TOKEN=your-github-token
   ```

3. Press `F5` in VS Code or use the "Debug Action" launch configuration

### Environment Variables

The `.env` file supports all GitHub Actions
[default environment variables](https://docs.github.com/en/actions/learn-github-actions/variables#default-environment-variables).
See `.env.example` for the full list.

## Development Workflow

### Running Tests

```bash
npm test
```

Tests are located in `__tests__/` and use Jest. Fixtures are in `__fixtures__/`.

### Linting

Before committing, ensure all linting checks pass:

```bash
npm run lint
```

To auto-fix formatting issues:

```bash
npm run format:write
```

### Building

Bundle the TypeScript code:

```bash
npm run bundle
```

This command will:

1. Format the code with Prettier
2. Check licenses with `licensed`
3. Bundle TypeScript to JavaScript in `dist/`

### Running Everything

To run format, lint, test, coverage badge generation, and bundling:

```bash
npm run all
```

### License Compliance

This project uses [licensed](https://github.com/github/licensed) to check
dependency licenses. The license check runs as part of `npm run bundle`.

To manually check licenses:

```bash
licensed status
```

To update the license cache:

```bash
licensed cache
```

## Project Structure

| Path             | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `src/`           | TypeScript source code                                   |
| `dist/`          | Generated JavaScript (do not edit directly)              |
| `__tests__/`     | Unit tests                                               |
| `__fixtures__/`  | Test fixtures                                            |
| `.devcontainer/` | Dev Container configuration                              |
| `.github/`       | GitHub configuration (workflows, issue templates, etc.)  |
| `.vscode/`       | VS Code configuration                                    |
| `.licenses/`     | License cache (generated by `licensed`)                  |
| `docs/`          | Research documents and specifications                    |

## Pull Request Guidelines

- Keep changes focused and minimal
- Ensure all linting and tests pass
- Update `dist/` by running `npm run bundle`
- Update documentation if functionality changes
- Follow [conventional commit](https://www.conventionalcommits.org/) message
  format

For more detailed guidelines, see
[.github/copilot-instructions.md](.github/copilot-instructions.md).
