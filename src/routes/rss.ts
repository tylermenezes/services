import { Router } from 'express';
import Parser from 'rss-parser';
import RSS from 'rss';
import sanitizeHtml from 'sanitize-html';
import { minify } from 'html-minifier-terser';
import config from '@/config';

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
            allowVulnerableTags: true,
            allowedTags: [
              "header", "h1", "h2", "h3", "h4", "img",
              "h5", "h6", "hgroup", "blockquote", "style",
              "figcaption", "figure", "hr", "li", "ol", "p", "pre",
              "ul", "abbr", "b", "bdi", "bdo", "br", "cite", "code",
              "em", "i", "strong", "sub", "sup", "caption",
            ],
            allowedAttributes: {
              '*': ['style'],
              a: [ 'href', 'name', 'target' ],
              img: [ 'src', 'srcset', 'width', 'height'],
            },
            transformTags: {
              img: (tagName, attribs) => {
                const newAttribs: Record<string, string> = {};
                if (attribs.width && parseInt(attribs.width).toString() == attribs.width) {
                  newAttribs.width = `${attribs.width}px`
                }
                if (attribs.height && parseInt(attribs.height).toString() == attribs.height) {
                  newAttribs.height = `${attribs.height}px`
                }
                if (newAttribs.width || newAttribs.height) {
                  newAttribs.style = (attribs.style || '')
                    + (attribs.style && attribs.style.length > 0 && attribs.style.endsWith(';') ? '' : ';')
                    + 'max-width: 100% !important; max-height: 100% !important;'
                    + Object.entries(newAttribs).map(([k, v]) => `${k}:${v} !important`).join(';');
                }
                return { tagName, attribs: { ...attribs, ...newAttribs } };
              }
            },
            allowedStyles: {
              '*': {
                width: [/.*/],
                height: [/.*/],
                'max-width': [/.*/],
                'max-height': [/.*/],
                display: [/.*/],
                float: [/.*/],
                'font-size': [/.*/],
                'text-align': [/.*/],
              },
            },
          }
        ),
        {
          collapseWhitespace: true,
          continueOnParseError: true,
          removeComments: true,
          removeEmptyAttributes: true,
          removeEmptyElements: true,
        }
      ),
      date: item.pubDate!,
      author: item.author,
    });
  }

  res.setHeader(
    'Content-type',
    config.app.debug ? 'text/plain' : 'application/rss+xml'
  );
  res.send(feed.xml({indent: true}));
});

export default router;
