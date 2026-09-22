export interface SchemaRuleSet {
  required: string[];
  recommended: string[];
}

const RULES: Record<string, SchemaRuleSet> = {
  Organization: {
    required: ['name', 'url'],
    recommended: ['logo', 'sameAs', 'contactPoint', 'description'],
  },
  LocalBusiness: {
    required: ['name', 'address'],
    recommended: ['telephone', 'openingHours', 'url', 'geo', 'sameAs'],
  },
  Person: {
    required: ['name'],
    recommended: ['url', 'sameAs', 'jobTitle', 'worksFor', 'image'],
  },
  Article: {
    required: ['headline', 'datePublished', 'author'],
    recommended: ['image', 'dateModified', 'publisher', 'description', 'url'],
  },
  BlogPosting: {
    required: ['headline', 'datePublished', 'author'],
    recommended: ['image', 'dateModified', 'publisher', 'description'],
  },
  NewsArticle: {
    required: ['headline', 'datePublished', 'author'],
    recommended: ['image', 'dateModified', 'publisher', 'description', 'articleSection'],
  },
  Product: {
    required: ['name'],
    recommended: ['description', 'image', 'offers', 'brand', 'sku'],
  },
  FAQPage: {
    required: ['mainEntity'],
    recommended: [],
  },
  WebSite: {
    required: ['name', 'url'],
    recommended: ['potentialAction', 'description'],
  },
  BreadcrumbList: {
    required: ['itemListElement'],
    recommended: [],
  },
  Event: {
    required: ['name', 'startDate'],
    recommended: ['endDate', 'location', 'description', 'organizer', 'image'],
  },
  HowTo: {
    required: ['name', 'step'],
    recommended: ['description', 'totalTime', 'tool', 'supply'],
  },
  Recipe: {
    required: ['name', 'recipeIngredient', 'recipeInstructions'],
    recommended: ['description', 'image', 'author', 'cookTime', 'nutrition'],
  },
  VideoObject: {
    required: ['name', 'description', 'thumbnailUrl', 'uploadDate'],
    recommended: ['duration', 'contentUrl', 'embedUrl'],
  },
  WebPage: {
    required: ['name', 'url'],
    recommended: ['description', 'breadcrumb', 'dateModified', 'author'],
  },
  NewsMediaOrganization: {
    required: ['name', 'url'],
    recommended: ['logo', 'sameAs', 'foundingDate', 'contactPoint', 'description'],
  },
  ItemList: {
    required: ['itemListElement'],
    recommended: ['name', 'description', 'numberOfItems'],
  },
  SoftwareApplication: {
    required: ['name', 'operatingSystem', 'applicationCategory'],
    recommended: ['offers', 'aggregateRating', 'screenshot', 'description'],
  },
};

const ALIASES: Record<string, string> = {
  Corporation: 'Organization',
  EducationalOrganization: 'Organization',
  GovernmentOrganization: 'Organization',
  MedicalOrganization: 'Organization',
  NGO: 'Organization',
  SportsOrganization: 'Organization',
  Restaurant: 'LocalBusiness',
  Hotel: 'LocalBusiness',
  Store: 'LocalBusiness',
  LegalService: 'LocalBusiness',
  // WebPage subtypes
  AboutPage: 'WebPage',
  ContactPage: 'WebPage',
  ProfilePage: 'WebPage',
  ItemPage: 'WebPage',
  CollectionPage: 'WebPage',
  CheckoutPage: 'WebPage',
  // Article subtypes
  TechArticle: 'Article',
  ScholarlyArticle: 'Article',
  ReportageNewsArticle: 'NewsArticle',
};

/** Short type name from compact or IRI `@type` (`https://schema.org/Article` → `Article`). */
export function schemaTypeName(type: string): string {
  const trimmed = type.trim();
  const hash = trimmed.lastIndexOf('#');
  const slash = trimmed.lastIndexOf('/');
  const cut = Math.max(hash, slash);

  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** Returns required/recommended property rules for a schema.org type (with aliases). */
export function getRulesForType(type: string): SchemaRuleSet | null {
  const name = schemaTypeName(type);

  return RULES[name] ?? RULES[ALIASES[name] ?? ''] ?? null;
}

/** Returns true when the type has validation rules in the schema rules registry. */
export function isKnownType(type: string): boolean {
  const name = schemaTypeName(type);

  return name in RULES || name in ALIASES;
}
