import { jest } from '@jest/globals'

const mockReposGet = jest.fn()
const mockReposListTags = jest.fn()
const mockCreateSnapshot = jest.fn()

// Separate mocks for public GitHub instance
const mockPublicReposGet = jest.fn()
const mockPublicReposListTags = jest.fn()

export const getOctokit = jest.fn((token: string, options?: { baseUrl?: string }) => {
  // Return different mock instances based on baseUrl
  if (options?.baseUrl === 'https://api.github.com') {
    return {
      rest: {
        repos: {
          get: mockPublicReposGet,
          listTags: mockPublicReposListTags
        },
        dependencyGraph: {
          createRepositorySnapshot: mockCreateSnapshot
        }
      }
    }
  }
  
  return {
    rest: {
      repos: {
        get: mockReposGet,
        listTags: mockReposListTags
      },
      dependencyGraph: {
        createRepositorySnapshot: mockCreateSnapshot
      }
    }
  }
})

// Export the mocks so tests can access them
export const mockOctokit = {
  rest: {
    repos: {
      get: mockReposGet,
      listTags: mockReposListTags
    },
    dependencyGraph: {
      createRepositorySnapshot: mockCreateSnapshot
    }
  }
}

// Export public GitHub mocks
export const mockPublicOctokit = {
  rest: {
    repos: {
      get: mockPublicReposGet,
      listTags: mockPublicReposListTags
    }
  }
}

export const context = {
  sha: 'test-sha-123',
  ref: 'refs/heads/main',
  repo: {
    owner: 'test-owner',
    repo: 'test-repo'
  }
}
