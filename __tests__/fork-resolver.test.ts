/**
 * Unit tests for src/fork-resolver.ts
 */
import { jest } from '@jest/globals'
import * as github from '../__fixtures__/github.js'

jest.unstable_mockModule('@actions/github', () => github)

const { ForkResolver } = await import('../src/fork-resolver.js')

describe('ForkResolver', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset all mock implementations and clear all mock state (including mockResolvedValueOnce and default implementations)
    github.mockOctokit.rest.repos.get.mockReset()
    github.mockOctokit.rest.repos.listTags.mockReset()
    github.mockPublicOctokit.rest.repos.get.mockReset()
    github.mockPublicOctokit.rest.repos.listTags.mockReset()
  })

  describe('resolveDependencies', () => {
    it('Returns dependencies without fork info for non-fork organizations', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: ['myorg'],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4'
      })
      expect(result[0].original).toBeUndefined()
    })

    it('Resolves fork using GitHub API', async () => {
      // First call for getOctokitForRepo check
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // Second call for getRepoInfo to get fork info
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: true,
          parent: {
            owner: { login: 'actions' },
            name: 'checkout'
          }
        }
      })

      const resolver = new ForkResolver({
        forkOrganizations: ['myorg'],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'checkout',
          ref: 'v4',
          uses: 'myorg/checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        owner: 'myorg',
        repo: 'checkout',
        ref: 'v4',
        original: {
          owner: 'actions',
          repo: 'checkout'
        }
      })
      expect(github.mockOctokit.rest.repos.get).toHaveBeenCalledWith({
        owner: 'myorg',
        repo: 'checkout'
      })
    })

    it('Resolves fork using regex pattern', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: ['myenterprise'],
        forkRegex: /^myenterprise\/(?<org>[^_]+)_(?<repo>.+)/,
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myenterprise',
          repo: 'actions_checkout',
          ref: 'v4',
          uses: 'myenterprise/actions_checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toEqual({
        owner: 'actions',
        repo: 'checkout'
      })
    })

    it('Handles API errors gracefully', async () => {
      github.mockOctokit.rest.repos.get.mockRejectedValueOnce(
        new Error('API Error')
      )

      const resolver = new ForkResolver({
        forkOrganizations: ['myorg'],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'checkout',
          ref: 'v4',
          uses: 'myorg/checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toBeUndefined()
    })

    it('Deduplicates dependencies with same owner/repo/ref and sourcePath', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4',
          sourcePath: '.github/workflows/ci.yml'
        },
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4',
          sourcePath: '.github/workflows/ci.yml'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
    })

    it('Preserves dependencies with same owner/repo/ref but different sourcePaths', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4',
          sourcePath: '.github/workflows/ci.yml'
        },
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4',
          sourcePath: '.github/workflows/check-dist.yml'
        },
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4',
          sourcePath: '.github/workflows/linter.yml'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(3)
      expect(result[0].sourcePath).toBe('.github/workflows/ci.yml')
      expect(result[1].sourcePath).toBe('.github/workflows/check-dist.yml')
      expect(result[2].sourcePath).toBe('.github/workflows/linter.yml')
    })
  })

  describe('regex pattern matching', () => {
    it('Correctly applies regex with named groups', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: ['enterprise'],
        forkRegex: /^(?<org>[^/]+)\/actions-(?<repo>.+)$/,
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'enterprise',
          repo: 'actions-checkout',
          ref: 'v4',
          uses: 'enterprise/actions-checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toEqual({
        owner: 'enterprise',
        repo: 'checkout'
      })
    })

    it('Applies underscore-based naming convention regex', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: ['myenterprise'],
        forkRegex: /^myenterprise\/(?<org>[^_]+)_(?<repo>.+)/,
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myenterprise',
          repo: 'actions_checkout',
          ref: 'v4',
          uses: 'myenterprise/actions_checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toEqual({
        owner: 'actions',
        repo: 'checkout'
      })
    })
  })

  describe('SHA to version resolution', () => {
    it('Resolves SHA to most specific version tag', async () => {
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v6',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          },
          {
            name: 'v6.0.1',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          },
          {
            name: 'v6.0.0',
            commit: { sha: 'abc1234567890abcdef1234567890abcdef12345' }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('v6.0.1')
      expect(result[0].originalSha).toBe(
        '8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
    })

    it('Returns v6.*.* when only v6 tag matches SHA', async () => {
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v6',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          },
          {
            name: 'v5.2.1',
            commit: { sha: 'abc1234567890abcdef1234567890abcdef12345' }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('v6.*.*')
      expect(result[0].originalSha).toBe(
        '8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
    })

    it('Returns v6.0.* when only v6.0 tag matches SHA', async () => {
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v6.0',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          },
          {
            name: 'v6',
            commit: { sha: 'abc1234567890abcdef1234567890abcdef12345' }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('v6.0.*')
      expect(result[0].originalSha).toBe(
        '8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
    })

    it('Keeps SHA unchanged when no matching tags found', async () => {
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v5.2.1',
            commit: { sha: 'abc1234567890abcdef1234567890abcdef12345' }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('8e8c483db84b4bee98b60c0593521ed34d9990e8')
      expect(result[0].originalSha).toBeUndefined()
    })

    it('Resolves SHA to version from parent repo for forks', async () => {
      // First call to repos.get to determine where myorg/checkout lives (during fetchRepositoryTags)
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // First call to listTags for fork repo (no matching tags)
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: []
      })

      // Second call to repos.get for fork info (during findOriginalRepository in SHA resolution)
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: true,
          parent: {
            owner: { login: 'actions' },
            name: 'checkout'
          }
        }
      })

      // Third call to repos.get to determine where actions/checkout lives
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // Second call to listTags for parent repo (matching tags)
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v6.0.1',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          }
        ]
      })

      // Fourth call to repos.get for fork info (during fork resolution after SHA resolution)
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: true,
          parent: {
            owner: { login: 'actions' },
            name: 'checkout'
          }
        }
      })

      const resolver = new ForkResolver({
        forkOrganizations: ['myorg'],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'myorg/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('v6.0.1')
      expect(result[0].originalSha).toBe(
        '8e8c483db84b4bee98b60c0593521ed34d9990e8'
      )
      expect(result[0].original).toEqual({
        owner: 'actions',
        repo: 'checkout'
      })
    })

    it('Keeps non-SHA refs unchanged', async () => {
      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4'
        },
        {
          owner: 'actions',
          repo: 'setup-node',
          ref: 'main',
          uses: 'actions/setup-node@main'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(2)
      expect(result[0].ref).toBe('v4')
      expect(result[1].ref).toBe('main')
    })

    it('Handles listTags API errors gracefully', async () => {
      github.mockOctokit.rest.repos.listTags.mockRejectedValueOnce(
        new Error('API Error')
      )

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      // SHA should remain unchanged if API call fails
      expect(result[0].ref).toBe('8e8c483db84b4bee98b60c0593521ed34d9990e8')
    })

    it('Returns SHA when no semver tags match SHA', async () => {
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'release-2024-01',
            commit: { sha: '8e8c483db84b4bee98b60c0593521ed34d9990e8' }
          },
          {
            name: 'v6.0.1',
            commit: { sha: 'abc1234567890abcdef1234567890abcdef12345' }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: '8e8c483db84b4bee98b60c0593521ed34d9990e8',
          uses: 'actions/checkout@8e8c483db84b4bee98b60c0593521ed34d9990e8'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('8e8c483db84b4bee98b60c0593521ed34d9990e8')
    })
  })

  describe('EMU/DR/GHES with public GitHub fallback', () => {
    it('Falls back to public GitHub when repository not found locally', async () => {
      // Local instance doesn't have the repo (for getOctokitForRepo)
      github.mockOctokit.rest.repos.get.mockRejectedValueOnce(
        new Error('Not Found')
      )

      // Public GitHub has the repo for getOctokitForRepo check
      github.mockPublicOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // Public GitHub has the repo with fork info (for getRepoInfo)
      github.mockPublicOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: true,
          parent: {
            owner: { login: 'actions' },
            name: 'checkout'
          }
        }
      })

      const resolver = new ForkResolver({
        forkOrganizations: ['enterprise'],
        token: 'test-token',
        publicGitHubToken: 'public-token'
      })

      const dependencies = [
        {
          owner: 'enterprise',
          repo: 'checkout',
          ref: 'v4',
          uses: 'enterprise/checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toEqual({
        owner: 'actions',
        repo: 'checkout'
      })
      expect(github.mockPublicOctokit.rest.repos.get).toHaveBeenCalledWith({
        owner: 'enterprise',
        repo: 'checkout'
      })
    })

    it('Uses public GitHub for tags when repository found there', async () => {
      const testSha = 'abc1234567890abcdef1234567890abcdef12345'

      // Local instance doesn't have the repo
      github.mockOctokit.rest.repos.get.mockRejectedValueOnce(
        new Error('Not Found')
      )

      // Public GitHub has the repo
      github.mockPublicOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // Public GitHub has tags matching the SHA
      github.mockPublicOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: [
          {
            name: 'v4.1.0',
            commit: { sha: testSha }
          }
        ]
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token',
        publicGitHubToken: 'public-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: testSha,
          uses: `actions/checkout@${testSha}`
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].ref).toBe('v4.1.0')
      expect(result[0].originalSha).toBe(testSha)
      expect(github.mockPublicOctokit.rest.repos.listTags).toHaveBeenCalledWith(
        {
          owner: 'actions',
          repo: 'checkout',
          per_page: 100,
          page: 1
        }
      )
    })

    it('Caches the decision to use public GitHub', async () => {
      // First call: Local instance doesn't have the repo
      github.mockOctokit.rest.repos.get.mockRejectedValueOnce(
        new Error('Not Found')
      )

      // First call: Public GitHub has the repo
      github.mockPublicOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: false
        }
      })

      // Public GitHub has tags (first call for SHA resolution)
      github.mockPublicOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: []
      })

      const resolver = new ForkResolver({
        forkOrganizations: [],
        token: 'test-token',
        publicGitHubToken: 'public-token'
      })

      const dependencies = [
        {
          owner: 'actions',
          repo: 'checkout',
          ref: 'abc1234567890abcdef1234567890abcdef12345',
          uses: 'actions/checkout@abc1234567890abcdef1234567890abcdef12345'
        }
      ]

      await resolver.resolveDependencies(dependencies)

      // Should only call local repos.get once (subsequent calls use cache)
      expect(github.mockOctokit.rest.repos.get).toHaveBeenCalledTimes(1)
      // Should call public repos.get once to determine location
      expect(github.mockPublicOctokit.rest.repos.get).toHaveBeenCalledTimes(1)
    })
  })
})
