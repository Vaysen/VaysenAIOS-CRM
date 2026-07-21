import { ASSISTANT_ACTION_PROTOCOL, buildHealthPayload } from './health-metadata';

describe('buildHealthPayload', () => {
  it('reports the immutable release identity and assistant action contract', () => {
    expect(buildHealthPayload({
      RELEASE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      RELEASE_COMMIT_SHORT: '01234567',
      RELEASE_TAG: 'task-116-v0.1',
      BUILD_REVISION: '0123456789abcdef0123456789abcdef01234567',
    })).toEqual({
      status: 'ok',
      release: {
        commit: '0123456789abcdef0123456789abcdef01234567',
        commitShort: '01234567',
        tag: 'task-116-v0.1',
        buildCommit: '0123456789abcdef0123456789abcdef01234567',
        matchesBuild: true,
      },
      contracts: { assistantAction: ASSISTANT_ACTION_PROTOCOL },
    });
  });

  it('does not reflect malformed environment text in the public health response', () => {
    expect(buildHealthPayload({
      RELEASE_COMMIT: '<script>alert(1)</script>',
      RELEASE_COMMIT_SHORT: 'not-a-sha',
      RELEASE_TAG: 'tag with spaces',
      BUILD_REVISION: 'also not a sha',
    }).release).toEqual({
      commit: 'unknown',
      commitShort: 'unknown',
      tag: 'unknown',
      buildCommit: 'unknown',
      matchesBuild: false,
    });
  });

  it('detects a runtime revision that does not match the built image', () => {
    expect(buildHealthPayload({
      RELEASE_COMMIT: '0123456789abcdef0123456789abcdef01234567',
      RELEASE_COMMIT_SHORT: '01234567',
      RELEASE_TAG: 'task-116-v0.1',
      BUILD_REVISION: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }).release.matchesBuild).toBe(false);
  });
});
