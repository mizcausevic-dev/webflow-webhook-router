// collection_item_* events -> paths to purge from an edge cache or rebuild in a headless frontend.
export function cacheTagsFor(triggerType, payload) {
  const collectionId = payload?.collectionId ?? payload?.fieldData?._cid ?? null;
  const slug = payload?.fieldData?.slug ?? payload?.slug ?? null;
  const tags = [];
  if (collectionId) tags.push(`collection:${collectionId}`);
  if (slug) tags.push(`item:${slug}`);
  if (triggerType === 'site_publish') tags.push('site:all');
  return tags;
}

export function cmsInvalidationHandler({ purge }) {
  return async (payload, ctx) => {
    const tags = cacheTagsFor(ctx.triggerType, payload);
    if (tags.length) await purge(tags);
    return { purged: tags };
  };
}
