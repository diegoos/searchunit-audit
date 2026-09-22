import type { ParsedPage } from './htmlParser.ts';

/** Shown when schema and page meta do not identify the type. */
export const UNDEFINED_TYPE = 'Undefined';

export type SiteType =
  | 'saas'
  | 'ecommerce'
  | 'local-business'
  | 'publisher'
  | typeof UNDEFINED_TYPE;

export type PageKind =
  | 'home'
  | 'article'
  | 'product'
  | 'listing'
  | 'profile'
  | typeof UNDEFINED_TYPE;

const ARTICLE_SCHEMA = ['newsarticle', 'article', 'blogposting'];

const PUBLISHER_SCHEMA = ['newsmediaorganization', 'newsarticle', 'blogposting'];

function ogType(page: ParsedPage): string {
  return (page.social.openGraph.type ?? '').trim().toLowerCase();
}

function hasSchemaType(types: Set<string>, names: readonly string[]): boolean {
  return names.some((name) => types.has(name));
}

function classifyPageKind(page: ParsedPage, types: Set<string>): PageKind {
  const og = ogType(page);

  if (types.has('product') || og === 'product' || og.startsWith('product.')) {
    return 'product';
  }

  if (hasSchemaType(types, ARTICLE_SCHEMA) || og === 'article') {
    return 'article';
  }

  if (types.has('person') || og === 'profile') {
    return 'profile';
  }

  if (hasSchemaType(types, ['itemlist', 'collectionpage'])) {
    return 'listing';
  }

  if (og === 'website') {
    return 'home';
  }

  return UNDEFINED_TYPE;
}

function classifySiteType(types: Set<string>, pageKind: PageKind): SiteType {
  if (types.has('product') || pageKind === 'product') {
    return 'ecommerce';
  }

  if (hasSchemaType(types, PUBLISHER_SCHEMA)) {
    return 'publisher';
  }

  if ([...types].some((type) => type.includes('localbusiness'))) {
    return 'local-business';
  }

  if (types.has('softwareapplication')) {
    return 'saas';
  }

  return UNDEFINED_TYPE;
}

/** Classifies site type and page kind from schema.org types and Open Graph type. */
export function classifyPage(page: ParsedPage): { siteType: SiteType; pageKind: PageKind } {
  const types = new Set(page.structuredData.types.map((type) => type.toLowerCase()));
  const pageKind = classifyPageKind(page, types);

  return { siteType: classifySiteType(types, pageKind), pageKind };
}

export function expectedSchemaTypes(siteType: SiteType, pageKind: PageKind): string[] {
  const base: string[] = [];

  if (pageKind === 'article') {
    base.push('Article', 'NewsArticle', 'BlogPosting');
  }

  if (pageKind === 'product') {
    base.push('Product');
  }

  if (pageKind === 'profile') {
    base.push('Person');
  }

  if (pageKind === 'home') {
    base.push('Organization', 'WebSite');
  }

  switch (siteType) {
    case 'ecommerce':
      base.push('Product', 'Organization');
      break;
    case 'local-business':
      base.push('LocalBusiness', 'Organization');
      break;
    case 'publisher':
      base.push('Article', 'NewsArticle');
      break;
    case 'saas':
      base.push('SoftwareApplication', 'Organization');
      break;
    default:
      break;
  }

  return [...new Set(base)];
}
