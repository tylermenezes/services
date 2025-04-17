import { Router } from 'express';
import Parser from 'rss-parser';
import RSS from 'rss';
import sanitizeHtml from 'sanitize-html';
import { minify } from 'html-minifier-terser';

const router = Router();

router.get(`/rss/mailgrip/:id`, async (req, res) => {
  const parser = new Parser({
    customFields: {
      feed: ['lastBuildDate']
    },
  });
  const oldFeed = await parser.parseURL(`https://mailgrip.io/feed/${req.params.id}`);
  const feed = new RSS({
    title: oldFeed.title || '',
    description: oldFeed.description,
    generator: 'svc.tyler.vc',
    feed_url: `https://svc.tyler.vc/rss/mailgrip/${req.params.id}`,
    site_url: 'https://mailgrip.io/',
    pubDate: oldFeed.lastBuildDate,
  });

  for (const item of oldFeed.items) {
    feed.item({
      title: item.title!,
      url: item.link!,
      guid: item.guid!,
      description: await minify(
        sanitizeHtml(
          item.content!,
          {
            allowedTags: [
              "header", "h1", "h2", "h3", "h4", "img",
              "h5", "h6", "hgroup", "blockquote", "div",
              "figcaption", "figure", "hr", "li", "ol", "p", "pre",
              "ul", "abbr", "b", "bdi", "bdo", "br", "cite", "code",
              "em", "i", "small", "span", "strong", "sub", "sup", "caption",
            ],
          }
        ),
        { collapseWhitespace: true, continueOnParseError: true }
      ),
      date: item.pubDate!,
      author: item.author,
    });
  }

  res.setHeader('Content-type', 'application/rss+xml');
  res.send(feed.xml({indent: true}));
});

export default router;
