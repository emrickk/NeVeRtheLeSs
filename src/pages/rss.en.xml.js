import rss from '@astrojs/rss';
import { SITE_DESCRIPTION_EN, SITE_TITLE } from '../consts';
import { withBase } from '../utils/paths';
import { postFeedItems } from '../utils/post-feed';

// English feed: every post in English where an English version exists,
// otherwise in the post's own language. Items link with ?lang=en so the
// page opens in English for readers whose stored choice is Chinese.
export async function GET(context) {
  return rss({
    title: `${SITE_TITLE} (English)`,
    description: SITE_DESCRIPTION_EN,
    site: new URL(withBase('/'), context.site),
    customData: '<language>en</language>',
    items: await postFeedItems('en', context.site),
  });
}
