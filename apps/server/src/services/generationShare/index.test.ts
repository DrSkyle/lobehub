// @vitest-environment node
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GenerationShareData } from '@/database/models/generationShare';

const mocks = vi.hoisted(() => ({
  createPreSignedUrlForPreview: vi.fn(),
  fileServiceUserIds: [] as string[],
  findByShareIdWithAccessCheck: vi.fn(),
}));

vi.mock('@/database/models/generationShare', () => ({
  GenerationShareModel: { findByShareIdWithAccessCheck: mocks.findByShareIdWithAccessCheck },
}));

vi.mock('@/server/services/file', () => ({
  FileService: class {
    constructor(_db: unknown, userId: string) {
      mocks.fileServiceUserIds.push(userId);
    }
    createPreSignedUrlForPreview = mocks.createPreSignedUrlForPreview;
  },
}));

const {
  resolveSharedGenerationAssetKey,
  serveSharedGenerationAsset,
  sharedGenerationFileName,
  toSharedGenerationData,
} = await import('./index');

const share = (overrides: Partial<GenerationShareData> = {}): GenerationShareData =>
  ({
    asset: { height: 768, thumbnailUrl: 'gen/thumb.webp', url: 'gen/full.png', width: 1024 },
    createdAt: new Date('2026-11-16T08:00:00Z'),
    generationId: 'gen_1',
    model: 'flux-pro',
    ownerId: 'owner',
    pageViewCount: 3,
    prompt: 'A calm lake at dawn',
    provider: 'fal',
    shareId: 'Ab3xYz9Kq1Lm',
    topicTitle: 'Landscapes',
    type: 'image',
    visibility: 'link',
    workspaceId: null,
    ...overrides,
  }) as GenerationShareData;

describe('toSharedGenerationData', () => {
  it('exposes share-scoped addresses, never storage keys', () => {
    const data = toSharedGenerationData(share(), false);

    expect(data.asset).toEqual({
      coverUrl: '/webapi/share/generation/Ab3xYz9Kq1Lm/cover',
      downloadUrl: '/webapi/share/generation/Ab3xYz9Kq1Lm/media?download=1',
      duration: undefined,
      height: 768,
      lyrics: undefined,
      mediaUrl: '/webapi/share/generation/Ab3xYz9Kq1Lm/media',
      width: 1024,
    });
    expect(JSON.stringify(data)).not.toContain('gen/full.png');
    expect(data).toMatchObject({
      prompt: 'A calm lake at dawn',
      title: 'Landscapes',
      type: 'image',
    });
  });

  it('titles a song by its own title and keeps its lyrics', () => {
    const data = toSharedGenerationData(
      share({
        asset: {
          coverUrl: 'm/cover.jpg',
          lyrics: 'la la',
          title: 'Dawn Song',
          url: 'm/a.mp3',
        } as any,
        type: 'music',
      }),
      true,
    );

    expect(data).toMatchObject({ isOwner: true, title: 'Dawn Song', type: 'music' });
    expect(data.asset.lyrics).toBe('la la');
    expect(data.asset.coverUrl).toBe('/webapi/share/generation/Ab3xYz9Kq1Lm/cover');
  });

  it('has no cover address when the generation has no cover', () => {
    const data = toSharedGenerationData(share({ asset: { url: 'v/a.mp4' }, type: 'video' }), false);
    expect(data.asset.coverUrl).toBeUndefined();
  });
});

describe('resolveSharedGenerationAssetKey', () => {
  it('uses the thumbnail as the cover of an image and the cover art otherwise', () => {
    expect(resolveSharedGenerationAssetKey(share(), 'cover')).toBe('gen/thumb.webp');
    expect(
      resolveSharedGenerationAssetKey(
        share({ asset: { coverUrl: 'v/poster.jpg', url: 'v/a.mp4' }, type: 'video' }),
        'cover',
      ),
    ).toBe('v/poster.jpg');
    expect(resolveSharedGenerationAssetKey(share(), 'media')).toBe('gen/full.png');
  });
});

describe('sharedGenerationFileName', () => {
  it('names the download after the prompt, keeping the extension', () => {
    expect(sharedGenerationFileName(share(), 'gen/full.png')).toBe('A-calm-lake-at-dawn.png');
  });

  it('strips characters a file system rejects', () => {
    expect(sharedGenerationFileName(share({ prompt: 'a/b: "c"?' }), 'x.mp4')).toBe('a-b-c.mp4');
  });

  it('falls back to a stable name without a prompt', () => {
    expect(sharedGenerationFileName(share({ prompt: '' }), 'k')).toBe('lobehub-image-Ab3xYz9Kq1Lm');
  });
});

describe('serveSharedGenerationAsset', () => {
  const fetchImpl = vi.fn<typeof fetch>();

  beforeEach(() => {
    mocks.findByShareIdWithAccessCheck.mockReset();
    mocks.createPreSignedUrlForPreview.mockReset().mockResolvedValue('https://s3/signed?ttl=60');
    mocks.fileServiceUserIds = [];
    fetchImpl.mockReset().mockResolvedValue(
      new Response('bytes', {
        headers: {
          'accept-ranges': 'bytes',
          'content-length': '5',
          'content-type': 'image/png',
          'x-amz-request-id': 'internal',
        },
        status: 200,
      }),
    );
  });

  const run = (overrides: Partial<Parameters<typeof serveSharedGenerationAsset>[0]> = {}) =>
    serveSharedGenerationAsset({
      db: {} as any,
      download: false,
      fetchImpl,
      kind: 'media',
      shareId: 'Ab3xYz9Kq1Lm',
      ...overrides,
    });

  it('streams the bytes itself after the share check — no storage URL reaches the visitor', async () => {
    mocks.findByShareIdWithAccessCheck.mockResolvedValue(share());

    const res = await run({ userId: 'visitor' });

    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toBe('bytes');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    // Storage-internal headers are not passed through.
    expect(res.headers.get('x-amz-request-id')).toBeNull();
    expect(mocks.findByShareIdWithAccessCheck).toHaveBeenCalledWith({}, 'Ab3xYz9Kq1Lm', 'visitor');
    // Signed as the owner, short-lived, and only fetched server-side.
    expect(mocks.fileServiceUserIds).toEqual(['owner']);
    expect(mocks.createPreSignedUrlForPreview).toHaveBeenCalledWith('gen/full.png', 60);
    expect(fetchImpl).toHaveBeenCalledWith('https://s3/signed?ttl=60', { headers: undefined });
  });

  it('forwards Range so players can seek, keeping the partial response', async () => {
    mocks.findByShareIdWithAccessCheck.mockResolvedValue(share());
    fetchImpl.mockResolvedValue(
      new Response('yt', {
        headers: { 'content-range': 'bytes 2-3/5', 'content-type': 'video/mp4' },
        status: 206,
      }),
    );

    const res = await run({ range: 'bytes=2-3' });

    expect(fetchImpl).toHaveBeenCalledWith('https://s3/signed?ttl=60', {
      headers: { range: 'bytes=2-3' },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 2-3/5');
  });

  it('names a download after the prompt', async () => {
    mocks.findByShareIdWithAccessCheck.mockResolvedValue(share());

    const res = await run({ download: true });

    expect(res.headers.get('content-disposition')).toBe(
      "attachment; filename*=UTF-8''A-calm-lake-at-dawn.png",
    );
  });

  it('stops serving the moment the link is private — even mid-playback', async () => {
    mocks.findByShareIdWithAccessCheck.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'private' }),
    );

    const res = await run({ range: 'bytes=0-' });

    expect(res.status).toBe(403);
    expect(mocks.createPreSignedUrlForPreview).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is not found for an unknown link, a missing cover, or a missing object', async () => {
    mocks.findByShareIdWithAccessCheck.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'missing' }),
    );
    expect((await run()).status).toBe(404);

    mocks.findByShareIdWithAccessCheck.mockResolvedValueOnce(
      share({ asset: { url: 'v/a.mp4' }, type: 'video' }),
    );
    expect((await run({ kind: 'cover' })).status).toBe(404);

    mocks.findByShareIdWithAccessCheck.mockResolvedValueOnce(share());
    fetchImpl.mockResolvedValueOnce(new Response('NoSuchKey', { status: 404 }));
    expect((await run()).status).toBe(404);
  });
});
