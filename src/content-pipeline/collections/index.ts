import { CollectionSpec } from './collection.types';
import { ESSENTIAL } from './essential';

// A new collection is one spec file plus a line here; every stage is shared.
export const COLLECTIONS: CollectionSpec[] = [ESSENTIAL];

export function collectionBySlug(slug: string): CollectionSpec {
  const spec = COLLECTIONS.find((c) => c.slug === slug);
  if (!spec) throw new Error(`Unknown collection ${slug}; known: ${COLLECTIONS.map((c) => c.slug).join(', ')}`);
  return spec;
}
