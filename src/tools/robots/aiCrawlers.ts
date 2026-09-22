type CrawlerCategory = 'search' | 'training' | 'assistant';
type GeoImpact = 'critical' | 'high' | 'medium' | 'low';

export interface AICrawler {
  name: string;
  userAgent: string;
  category: CrawlerCategory;
  owner: string;
  geoImpact: GeoImpact;
}

export const AI_CRAWLERS: AICrawler[] = [
  {
    name: 'Googlebot',
    userAgent: 'Googlebot',
    category: 'search',
    owner: 'Google',
    geoImpact: 'critical',
  },
  {
    name: 'Bingbot',
    userAgent: 'Bingbot',
    category: 'search',
    owner: 'Microsoft',
    geoImpact: 'critical',
  },
  { name: 'GPTBot', userAgent: 'GPTBot', category: 'training', owner: 'OpenAI', geoImpact: 'high' },

  {
    name: 'OAI-SearchBot',
    userAgent: 'OAI-SearchBot',
    category: 'assistant',
    owner: 'OpenAI',
    geoImpact: 'high',
  },
  {
    name: 'ChatGPT-User',
    userAgent: 'ChatGPT-User',
    category: 'assistant',
    owner: 'OpenAI',
    geoImpact: 'high',
  },
  {
    name: 'Google-Extended',
    userAgent: 'Google-Extended',
    category: 'training',
    owner: 'Google',
    geoImpact: 'medium',
  },
  {
    name: 'PerplexityBot',
    userAgent: 'PerplexityBot',
    category: 'assistant',
    owner: 'Perplexity',
    geoImpact: 'high',
  },
  {
    name: 'ClaudeBot',
    userAgent: 'ClaudeBot',
    category: 'training',
    owner: 'Anthropic',
    geoImpact: 'medium',
  },
  {
    name: 'anthropic-ai',
    userAgent: 'anthropic-ai',
    category: 'assistant',
    owner: 'Anthropic',
    geoImpact: 'medium',
  },
  {
    name: 'CCBot',
    userAgent: 'CCBot',
    category: 'training',
    owner: 'Common Crawl',
    geoImpact: 'medium',
  },
  {
    name: 'Amazonbot',
    userAgent: 'Amazonbot',
    category: 'assistant',
    owner: 'Amazon',
    geoImpact: 'medium',
  },
  {
    name: 'Applebot',
    userAgent: 'Applebot',
    category: 'search',
    owner: 'Apple',
    geoImpact: 'medium',
  },
  {
    name: 'Applebot-Extended',
    userAgent: 'Applebot-Extended',
    category: 'training',
    owner: 'Apple',
    geoImpact: 'low',
  },
  {
    name: 'meta-externalagent',
    userAgent: 'meta-externalagent',
    category: 'training',
    owner: 'Meta',
    geoImpact: 'medium',
  },
  {
    name: 'Bytespider',
    userAgent: 'Bytespider',
    category: 'training',
    owner: 'ByteDance',
    geoImpact: 'low',
  },
  {
    name: 'DuckAssistBot',
    userAgent: 'DuckAssistBot',
    category: 'assistant',
    owner: 'DuckDuckGo',
    geoImpact: 'medium',
  },
  {
    name: 'cohere-ai',
    userAgent: 'cohere-ai',
    category: 'training',
    owner: 'Cohere',
    geoImpact: 'low',
  },
];
