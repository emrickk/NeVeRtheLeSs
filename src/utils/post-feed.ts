import { getCollection } from 'astro:content';
import { withBase } from './paths';
import { buildTranslationMap, resolveLangText, type Lang } from './translations';

export interface PostFeedItem {
  title: string;
  description: string;
  pubDate: Date;
  link: string;
}

/**
 * RSS items for one feed language. Each item uses that language's title and
 * description when the post has them (its own frontmatter or the sibling
 * translation's), otherwise the post's own language. English items link with
 * ?lang=en so the page opens in English; Chinese items use the plain URL.
 */
export async function postFeedItems(lang: Lang, site: URL): Promise<PostFeedItem[]> {
  const posts = (await getCollection('posts'))
    .filter((p) => !p.data.draft)
    .sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
  const tmap = await buildTranslationMap();

  return posts.map((post) => {
    const text = resolveLangText(post.data, tmap);
    const title = (lang === 'zh' ? text.titleZh : text.titleEn) ?? post.data.title;
    const description =
      (lang === 'zh' ? text.descriptionZh : text.descriptionEn) ?? post.data.description;
    const path = withBase(`/posts/${post.id}/`);
    return {
      title,
      description,
      pubDate: post.data.pubDate,
      link: lang === 'en' ? new URL(`${path}?lang=en`, site).href : path,
    };
  });
}
