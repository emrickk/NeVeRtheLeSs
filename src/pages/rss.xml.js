import rss from '@astrojs/rss';
import { SITE_DESCRIPTION, SITE_LANG, SITE_TITLE } from '../consts';
import { withBase } from '../utils/paths';
import { postFeedItems } from '../utils/post-feed';

// Chinese feed: every post in Chinese where a Chinese version exists,
// otherwise in the post's own language. The English feed is /rss.en.xml.
export async function GET(context) {
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: new URL(withBase('/'), context.site),
    customData: `<language>${SITE_LANG}</language>`,
    items: await postFeedItems('zh', context.site),
  });
}
