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
      expect(result[0]).toEqual({
        owner: 'actions',
        repo: 'checkout',
        ref: 'v4',
        original: undefined
      })
    })

    it('Resolves fork using GitHub API', async () => {
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
      expect(result[0]).toEqual({
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
        forkOrganizations: ['myorg'],
        forkRegex: /^(?<org>myorg)\/actions-(?<repo>.+)$/,
        token: 'test-token'
      })

      const dependencies = [
        {
          owner: 'myorg',
          repo: 'actions-checkout',
          ref: 'v4',
          uses: 'myorg/actions-checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
      expect(result[0].original).toEqual({
        owner: 'myorg',
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

    it('Deduplicates dependencies with same owner/repo/ref', async () => {
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
          repo: 'checkout',
          ref: 'v4',
          uses: 'actions/checkout@v4'
        }
      ]

      const result = await resolver.resolveDependencies(dependencies)

      expect(result).toHaveLength(1)
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
    })

    it('Resolves SHA to version from parent repo for forks', async () => {
      // First call to listTags for fork repo (no matching tags)
      github.mockOctokit.rest.repos.listTags.mockResolvedValueOnce({
        data: []
      })

      // First call to repos.get for fork info (during SHA resolution)
      github.mockOctokit.rest.repos.get.mockResolvedValueOnce({
        data: {
          fork: true,
          parent: {
            owner: { login: 'actions' },
            name: 'checkout'
          }
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

      // Second call to repos.get for fork info (during fork resolution)
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
})
