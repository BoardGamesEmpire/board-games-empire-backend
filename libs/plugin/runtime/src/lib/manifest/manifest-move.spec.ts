import {
  bindManifest,
  classifyManifestMove,
  describeManifestMove,
  type ClaimedPluginRow,
  type ManifestSnapshot,
} from './manifest-move';

const INSTALLED_AT = new Date('2026-01-01T00:00:00.000Z');

const expected: ManifestSnapshot = {
  version: '1.0.0',
  installedAt: INSTALLED_AT,
  manifestJson: { a: 1 },
};

function row(overrides: Partial<ClaimedPluginRow> = {}): ClaimedPluginRow {
  return {
    uninstalled_at: null,
    version: '1.0.0',
    installed_at: new Date(INSTALLED_AT.getTime()),
    manifest_matches: true,
    ...overrides,
  };
}

describe('classifyManifestMove', () => {
  it('returns null when every signal agrees', () => {
    expect(classifyManifestMove(row(), expected)).toBeNull();
  });

  it('names a moved installed_at a reinstall even when the version also moved', () => {
    const moved = row({ installed_at: new Date('2026-02-01T00:00:00.000Z'), version: '2.0.0' });

    expect(classifyManifestMove(moved, expected)).toBe('reinstalled');
  });

  it('names a moved version an activation', () => {
    expect(classifyManifestMove(row({ version: '2.0.0' }), expected)).toBe('version-activated');
  });

  it('names same-version different content an activation (#368)', () => {
    expect(classifyManifestMove(row({ manifest_matches: false }), expected)).toBe('version-activated');
  });

  it('treats a NULL comparison as a move, never as unchanged', () => {
    expect(classifyManifestMove(row({ manifest_matches: null }), expected)).toBe('version-activated');
  });
});

describe('bindManifest', () => {
  it('binds the plugin manifest as its JSON text', () => {
    expect(bindManifest({ a: 1 })).toBe('{"a":1}');
  });
});

describe('describeManifestMove (#578)', () => {
  it('says a reinstall happened and names the version it landed on', () => {
    const text = describeManifestMove('demo', 'reinstalled', '1.0.0', '2.0.0');

    expect(text).toContain("Plugin 'demo' was reinstalled at version 2.0.0");
    expect(text).not.toContain('1.0.0');
  });

  it('names both versions, expected first, for a version move', () => {
    const text = describeManifestMove('demo', 'version-activated', '1.0.0', '2.0.0');

    expect(text).toContain('was activated from version 1.0.0 to 2.0.0');
  });

  it('says same-version different content for an equal-version activation', () => {
    const text = describeManifestMove('demo', 'version-activated', '1.0.0', '1.0.0');

    expect(text).toContain('was re-activated at version 1.0.0 with different plugin manifest content');
  });
});
