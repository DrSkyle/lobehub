import type { NextRequest } from 'next/server';

import { getServerDB } from '@/database/server';
import { createLambdaContext } from '@/libs/trpc/lambda/context';
import {
  serveSharedGenerationAsset,
  SHARED_GENERATION_ASSET_KINDS,
  type SharedGenerationAssetKind,
} from '@/server/services/generationShare';

type Params = Promise<{ kind: string; shareId: string }>;

/** The visitor's user id, if any; a missing or broken session just means anonymous. */
const readSessionUserId = async (req: NextRequest) => {
  try {
    return (await createLambdaContext(req)).userId ?? null;
  } catch {
    return null;
  }
};

/**
 * Share-scoped asset of a shared generation:
 * GET /webapi/share/generation/:shareId/(media|cover)[?download=1]
 *
 * Re-checks the share on every request (each `Range` request included) and
 * streams the bytes, so a link turned private stops serving at once; no
 * storage URL ever reaches the visitor. The visitor's session only matters for
 * an owner previewing a still-private link.
 */
export const GET = async (req: NextRequest, segmentData: { params: Params }) => {
  const { kind, shareId } = await segmentData.params;
  if (!SHARED_GENERATION_ASSET_KINDS.includes(kind as SharedGenerationAssetKind)) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const db = await getServerDB();
    const userId = await readSessionUserId(req);

    return await serveSharedGenerationAsset({
      db,
      download: new URL(req.url).searchParams.get('download') === '1',
      kind: kind as SharedGenerationAssetKind,
      range: req.headers.get('range'),
      shareId,
      userId,
    });
  } catch (error) {
    console.error('Shared generation asset error:', error);
    return new Response('Internal server error', { status: 500 });
  }
};
